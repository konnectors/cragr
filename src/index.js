const {BaseKonnector, log, request, errors, updateOrCreate, addData, saveFiles} = require('cozy-konnector-libs')
const xlsx = require('xlsx')
const bluebird = require('bluebird')
const moment = require('moment')
const url = require('url')

// time given to the connector to save the files
const FULL_TIMEOUT = Date.now() + 60 * 1000

const rq = request({
  // debug: true,
  jar: true,
  json: false,
  cheerio: true
})

let loginUrl = null
let baseUrl = null
let statementsUrl = null
let fields = {}

module.export = new BaseKonnector(start)

function start (requiredFields) {
  fields = requiredFields
  return fetchBankUrl(fields.bankId)
  .then(login)
  .then(parseAccounts)
  .then(saveAccounts)
  .then(comptes => bluebird.each(comptes, compte => {
    return fetchOperations(compte)
    .then(operations => saveOperations(compte, operations))
  }))
  .then(getDocuments)
}

function fetchBankUrl (bankId) {
  return rq('https://www.credit-agricole.fr')
  .then($ => {
    log('info', 'Getting the list of banks')
    const script = Array.from($('script')).find(script => {
      return $(script).html().includes('CR_infos_v2')
    })

    if (!script) {
      log('error', 'Failed to get the list of available banks')
      throw new Error(errors.VENDOR_DOWN)
    }

    const assoc = JSON.parse($(script).html().match(/= ({.*});/)[1])
    const result = {}
    for (let key in assoc) {
      result[assoc[key].id_caisse] = assoc[key].url
    }

    const bankUrl = result[bankId]

    if (bankUrl === undefined) {
      log('error', `The bank id ${bankId} is unknown`)
      throw new Error(errors.LOGIN_FAILED)
    }

    log('info', `Bank url is ${bankUrl}`)
    return bankUrl
  })
}

function cleanDocumentLabel (label) {
  // remove some special characters from the label
  return label
    .trim()
    .split(' ')
    .filter(l => l.length)
    .join('_')
    .replace('.', '')
}

function getDocuments () {
  log('info', 'Getting accounts statements')
  return fetchStatementPage()
  .then(parseStatementsPage)
  .then(accounts => bluebird.each(accounts, fetchAndSaveAccountDocuments))
}

function fetchAccountDocuments (account, index) {
  return rq(account.link)
  .then($ => {
    log('info', account.label)
    // now get all the links to the releves of this account
    const entries = Array.from($('#panneau1 table tbody').eq(index).find('tr[title]')).map(elem => {
      const $cells = $(elem).find('td')
      const date = $cells.eq(0).text().split('/').reverse().join('')
      const link = $cells.eq(3).find('a').attr('href').split(';')[1].match(/\('(.*)'\)/)[1]
      return {
        fileurl: `${baseUrl}/stb/${link}&typeaction=telechargement`,
        filename: `releve_${date}_${account.label}.pdf`
      }
    })
    return entries
  })
}

function saveAccountDocuments (entries, index, length) {
  // Give an equal time to fetch documents for each account
  // next documents will be downloaded for the next run
  const remainingTime = FULL_TIMEOUT - Date.now()
  const timeForThisAccount = remainingTime / (length - index)
  return saveFiles(entries, fields, {
    timeout: Date.now() + timeForThisAccount
  })
}

function fetchAndSaveAccountDocuments (account, index, length) {
  return fetchAccountDocuments(account, index)
  .then(entries => saveAccountDocuments(entries, index, length))
}

function parseStatementsPage ($) {
  // find the "Releve de comptes" section
  // here I suppose the fist section is always the releves de comptes section but the name is
  // checked
  log('info', 'Getting the list of accounts with account statements')
  if ($('#entete1').text().trim() === 'RELEVES DE COMPTES') {
    // get the list of accounts with links to display the details
    const accounts = Array.from($('#panneau1 .ca-table tbody')).map(account => {
      const $account = $(account)
      const label = cleanDocumentLabel($account.find('tr').eq(0).find('a').eq(1).text())

      const link = $account.find('.fleche-ouvrir').attr('href')
      return { label, link: `${baseUrl}/stb/${link}` }
    })
    return accounts
  } else {
    log('warning', 'No account statement')
    return []
  }
}

function fetchStatementPage () {
  return rq(statementsUrl)
}

function saveOperations (account, operations) {
  return addData(operations, 'io.cozy.bank.operations')
}

function fetchOperations (account) {
  log('info', `Gettings operations for ${account.label}`)

  const rq = request({
    cheerio: false
  })
  return rq({
    url: `${baseUrl}/stb/${account.linkOperations}&typeaction=telechargement`,
    encoding: 'binary'
  })
  .then(body => {
    const workbook = xlsx.read(body, {
      type: 'string',
      raw: true
    })
    const worksheet = workbook.Sheets[workbook.SheetNames[0]]
    return xlsx.utils.sheet_to_csv(worksheet).split('\n').slice(9).filter(line => {
      return line.length > 3 // avoid lines with empty cells
    }).map(line => {
      const cells = line.split(',')
      const labels = cells[1].split('\u001b :').map(elem => elem.trim())

      // select the right cell if it is a debit or a credit
      let amount = 0
      if (cells[2].length) {
        amount = parseFloat(cells[2]) * -1
      } else if (cells[3].length) {
        amount = parseFloat(cells[3])
      } else {
        log('error', cells, 'Could not find an amount in this operation')
      }

      // some months are abbreviated in French and other in English!!! + encoding problem
      // TODO use the real csv export (but which is harder to reach) which has better dates
      const date = cells[0].toLowerCase().replace('dã©c', 'dec').replace('aoã»', 'aug')

      // FIXME a lot of information is hidden in the label of the operation (type of operation,
      // real date of the operation) but the formating is quite inconsistent
      return {
        date: moment(date, 'DD-MMM').toDate(),
        label: labels.shift(),
        type: 'none', // TODO parse the labels for that
        dateImport: new Date(),
        dateOperation: date, // TODO parse the label for that
        currency: 'EUR',
        amount,
        account: `${account._id}`
      }
    })
  })
}

function saveAccounts (accounts) {
  return updateOrCreate(accounts, 'io.cozy.bank.accounts', ['number'])
}

function parseAccounts ($) {
  log('info', 'Gettings accounts')
  const comptes = Array.from($('.ca-table tbody tr img'))
    .map(compte => $(compte).closest('tr'))
    .map(compte => Array.from($(compte).find('td'))
        .map(td => {
          const $td = $(td)
          let text = $td.text().trim()

          // Get the full label of the account which is onmouseover event
          const mouseover = $td.attr('onmouseover') || ''
          let fullText = mouseover.match(/'(.*)'/)
          if (fullText) text = fullText[1]

          // if there is an image in the td then get the link to the csv
          if ($td.find('img').length) {
            text = $td.find('a').attr('href').match(/\('(.*)'\)/)[1]
          }

          return text
        })
        .filter(td => td.length > 0)
    )

  const label2Type = {
    'LIVRET A': 'bank',
    'COMPTE CHEQUE': 'bank'
    // to complete when we have more data
  }

  return comptes.map(compte => ({
    institutionLabel: 'Crédit Agricole',
    type: label2Type[compte[0]] || 'UNKNOWN LABEL',
    label: compte[0],
    number: compte[1],
    balance: parseFloat(compte[2].replace(' ', '').replace(',', '.')),
    linkOperations: compte[5]
  }))
}

function login (bankUrl) {
  log('info', 'Logging in')
  return rq(`${bankUrl}/particuliers.html`)
  .then($ => {
    const script = Array.from($('script'))
      .map(script => $(script).html().trim())
      .find(script => {
        return script.match(/var chemin = "/)
      })

    loginUrl = script.match(/var chemin = "(.*)".*\|/)[1]

    const urlObj = url.parse(loginUrl)
    baseUrl = `${urlObj.protocol}//${urlObj.hostname}`

    return rq({
      url: loginUrl,
      method: 'POST',
      form: {
        TOP_ORIGINE: 'V',
        vitrine: 'O',
        largeur_ecran: '800',
        hauteur_ecran: '600',
        origine: 'vitrine',
        situationTravail: 'BANQUAIRE',
        canal: 'WEB',
        typeAuthentification: 'CLIC_ALLER',
        urlOrigine: 'http://www.ca-paris.fr',
        tracking: 'O'
      }
    })
  })
  .then($ => {
    const touches = Array.from($('#pave-saisie-code td a')).filter(touche => $(touche).text().trim() !== '')
    const decodeTable = touches.reduce((memo, touche) => {
      const $touche = $(touche)
      memo[$touche.text().trim()] = $touche.closest('td').attr('onclick').match(/'(.*)'/)[1]
      return memo
    }, {})

    const password = fields.password.split('').map(nb => decodeTable[nb]).join(',')

    return rq({
      method: 'POST',
      url: loginUrl,
      form: {
        idtcm: '',
        tracking: 'O',
        origine: 'vitrine',
        situationTravail: 'BANCAIRE',
        canal: 'WEB',
        typeAuthentification: 'CLIC_RETOUR',
        idUnique: $('input[name=idUnique]').val(),
        caisse: $('input[name=caisse]').val(),
        CCCRYC: password,
        CCCRYC2: '000000',
        CCPTE: fields.login
      }
    })
  })
  .then($ => {
    const idSessionSag = $('input[name=sessionSAG]').attr('value')
    statementsUrl = `${baseUrl}/stb/entreeBam?sessionSAG=${idSessionSag}&stbpg=pagePU&act=Edocsynth&stbzn=bnt&actCrt=Edocsynth#null`
    if ($('.ca-table tbody tr img').length) {
      log('info', 'LOGIN_OK')
      return $
    } else {
      throw new Error(errors.LOGIN_FAILED)
    }
  })
}

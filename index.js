const {BaseKonnector, log, request, errors, updateOrCreate, addData, filterData} = require('cozy-konnector-libs')
const xlsx = require('xlsx')
const fs = require('fs')
const path = require('path')
const bluebird = require('bluebird')
const moment = require('moment')
const url = require('url')

let rq = request({
  // debug: true,
  jar: true,
  json: false,
  cheerio: true
})

let loginUrl = null
let baseUrl = null

module.export = new BaseKonnector(start)

function start (fields) {
  return login(fields)
  .then(parseAccounts)
  .then(saveAccounts)
  .then(comptes => bluebird.each(comptes, compte => {
    return fetchOperations(compte)
    .then(operations => saveOperations(compte, operations))
  }))
}

function saveOperations (account, operations) {
  // Deduplicate on this keys "naive" version
  const options = {
    keys: ['account', 'date', 'amount'],
    selector: {
      account: account.number
    }
  }

  return filterData(operations, 'io.cozy.bank.operations', options)
  .then(entries => addData(operations, 'io.cozy.bank.operations'))
}

function fetchOperations (account) {
  log('info', `Gettings operations for ${account.label}`)

  rq = request({
    cheerio: false
  })
  return rq({
    url: `${baseUrl}/stb/${account.linkOperations}&typeaction=telechargement`,
    encoding: 'binary'
  })
  .then(body => {
    // I add some encoding problems when using xlsx.read
    // but this is clearly a FIXME
    // Fetching a csv file instead of slk file may avoid this problem but this is harder to reach.
    const tmpFile = path.resolve('temp.slk')
    fs.writeFileSync(tmpFile, body, {
      encoding: 'binary'
    })
    const workbook = xlsx.readFile(tmpFile, {
      type: 'string',
      raw: true
    })
    fs.unlinkSync(tmpFile)
    const worksheet = workbook.Sheets[workbook.SheetNames[0]]
    return xlsx.utils.sheet_to_csv(worksheet).split('\n').slice(9).filter(line => {
      return line.length > 3 // avoid lines with empty cells
    }).map(line => {
      const cells = line.split(',')
      const labels = cells[1].split('\u001b :').map(elem => elem.trim()).join(';')

      let amount = 0
      if (cells[2].length) {
        amount = parseFloat(cells[2]) * -1
      } else if (cells[3].length) {
        amount = parseFloat(cells[3])
      } else {
        log('error', cells, 'Could not find an amount in this operation')
      }

      // some months are abbreviated in French and other in English!!!
      // TODO use the real csv export (but which is harder to reach) which has better dates
      const date = cells[0].toLowerCase().replace('déc', 'dec').replace('aoû', 'aug')

      // FIXME a lot of information is hidden in the label of the operation (type of operation,
      // real date of the operation) but the formating is quite inconsistent
      return {
        date: moment(date, 'DD-MMM').toDate(),
        label: labels,
        type: 'none', // TODO parse the labels for that
        dateImport: new Date(),
        dateOperation: date, // TODO parse the label for that
        currency: 'EUR',
        amount,
        account: `io.cozy.bank.accounts:${account._id}`
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

function login (fields) {
  log('info', 'Logging in')
  return rq('https://www.ca-paris.fr/particuliers.html')
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
    if ($('.ca-table tbody tr img').length) {
      log('info', 'LOGIN_OK')
      return $
    } else {
      throw new Error(errors.LOGIN_FAILED)
    }
  })
}

const {
  requestFactory,
  log,
  saveFiles,
  errors
} = require('cozy-konnector-libs')

const helpers = require('./helpers')

const request = requestFactory({
  // debug: true,
  jar: true,
  json: false,
  cheerio: true
})

const groupBy = require('lodash/groupBy')
const url = require('url')
const xlsx = require('xlsx')
const moment = require('moment')
const bluebird = require('bluebird')

// time given to the connector to save the files
const FULL_TIMEOUT = Date.now() + 4 * 60 * 1000

let baseUrl = null
let loginUrl = null
let statementsUrl = null
let fields = {}

const bankLabel = 'Crédit Agricole'

function oldLogin(bankUrl, fieldsParams) {
  log('info', 'Try to login with old scheme')

  fields = fieldsParams

  return request(`${bankUrl}/particuliers.html`)
    .then($ => {
      const script = Array.from($('script'))
        .map(script =>
          $(script)
            .html()
            .trim()
        )
        .find(script => {
          return script.match(/var chemin = "/)
        })

      loginUrl = script.match(/var chemin = "(.*)".*\|/)[1]

      const urlObj = url.parse(loginUrl)
      baseUrl = `${urlObj.protocol}//${urlObj.hostname}`

      return request({
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
      const touches = Array.from($('#pave-saisie-code td a')).filter(
        touche =>
          $(touche)
            .text()
            .trim() !== ''
      )
      const decodeTable = touches.reduce((memo, touche) => {
        const $touche = $(touche)
        memo[$touche.text().trim()] = $touche
          .closest('td')
          .attr('onclick')
          .match(/'(.*)'/)[1]
        return memo
      }, {})

      const password = fields.password
        .split('')
        .map(nb => decodeTable[nb])
        .join(',')

      return request({
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
    .catch($ => {
      if ($.statusCode == 404) {
        // return lib.newlogin(bankUrl)
        return null
      } else {
        log('error', `Status code: ${$.statusCode}`)
        throw new Error(errors.VENDOR_DOWN)
      }
    })
}

function parseAccount($) {
  const accounts = Array.from($('.ca-table tbody tr img'))
    .map(account => $(account).closest('tr'))
    .map(account =>
      Array.from($(account).find('td'))
        .map(td => {
          const $td = $(td)
          let text = $td.text().trim()

          // Get the full label of the account which is onmouseover event
          const mouseover = $td.attr('onmouseover') || ''
          let fullText = mouseover.match(/'(.*)'/)
          if (fullText) text = fullText[1]

          // if there is an image in the td then get the link to the csv
          if ($td.find('img').length) {
            text = $td
              .find('a')
              .attr('href')
              .match(/\('(.*)'\)/)[1]
          }

          return text
        })
        .filter(td => td.length > 0)
    )

  return accounts.map(account => {
    const operationsLink = account[account.length - 1]
    return {
      institutionLabel: bankLabel,
      type: helpers.getAccountType(account[0]),
      label: account[0],
      number: account[1],
      vendorId: account[1],
      balance: parseFloat(account[2].replace(' ', '').replace(',', '.')),
      linkOperations: operationsLink
    }
  })
}

function parseOperations(account, body) {
  const workbook = body.Sheets
    ? body
    : xlsx.read(body, {
        type: 'string',
        raw: true
      })

  const worksheet = workbook.Sheets[workbook.SheetNames[0]]

  // first get the full date
  const lines = xlsx.utils.sheet_to_csv(worksheet).split('\n')

  const operations = lines
    .slice(9)
    .filter(line => {
      return line.length > 3 // avoid lines with empty cells
    })
    .map(line => {
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
      let date = parseDate(
        cells[0]
          .toLowerCase()
          .replace('é', 'e')
          .replace('û', 'u')
      )

      // adjust the date since we do not have the year in the document but we know the document
      // gives us a 6 month timeframe
      const limit = moment().add(1, 'day')
      if (date.isAfter(limit)) {
        date.subtract(1, 'year')
      }

      // FIXME a lot of information is hidden in the label of the operation (type of operation,
      // real date of the operation) but the formating is quite inconsistent
      return {
        date: date.toDate(),
        label: labels[0],
        originalLabel: labels.join('\n'),
        type: 'none', // TODO parse the labels for that
        dateImport: new Date(),
        dateOperation: date.toDate(), // TODO parse the label for that
        currency: 'EUR',
        vendorAccountId: account.number,
        amount
      }
    })

  forgeVendorId(account, operations)

  return operations
}

function forgeVendorId(account, operations) {
  // Forge a vendorId by concatenating account number, day YYYY-MM-DD and index
  // of the operation during the day
  const groups = groupBy(operations, x => x.date.toISOString().slice(0, 10))
  Object.entries(groups).forEach(([date, group]) => {
    group.forEach((operation, i) => {
      operation.vendorId = `${account.number}_${date}_${i}`
    })
  })
}

async function fetchOperations(account) {
  log('info', `Gettings operations for ${account.label}`)

  const request = requestFactory({
    cheerio: false,
    jar: true
  })

  return request({
    url: `${baseUrl}/stb/${account.linkOperations}&typeaction=telechargement`,
    encoding: 'binary'
  })
}

function fetchDocuments() {
  log('info', 'Getting accounts statements')
  return fetchStatementPage()
    .then(parseStatementsPage)
    .then(accounts => bluebird.each(accounts, fetchAndSaveAccountDocuments))
}

function fetchStatementPage() {
  return request(statementsUrl)
}

function parseStatementsPage($) {
  // find the "Releve de comptes" section
  // here I suppose the fist section is always the releves de comptes section but the name is
  // checked
  log('info', 'Getting the list of accounts with account statements')
  if (
    $('#entete1')
      .text()
      .trim() === 'RELEVES DE COMPTES'
  ) {
    // get the list of accounts with links to display the details
    const accounts = Array.from($('#panneau1 .ca-table tbody')).map(account => {
      const $account = $(account)
      const label = helpers.cleanDocumentLabel(
        $account
          .find('tr')
          .eq(0)
          .find('a')
          .eq(1)
          .text()
      )

      const link = $account.find('.fleche-ouvrir').attr('href')
      return { label, link: `${baseUrl}/stb/${link}` }
    })
    return accounts
  } else {
    log('warning', 'No account statement')
    return []
  }
}

function fetchAccountDocuments(account, index) {
  return request(account.link).then($ => {
    log('info', account.label)
    // now get all the links to the releves of this account
    const entries = Array.from(
      $('#panneau1 table tbody')
        .eq(index)
        .find('tr[title]')
    ).map(elem => {
      const $cells = $(elem).find('td')
      const date = $cells
        .eq(0)
        .text()
        .split('/')
        .reverse()
        .join('')
      const link = $cells
        .eq(3)
        .find('a')
        .attr('href')
        .split(';')[1]
        .match(/\('(.*)'\)/)[1]
      return {
        fileurl: `${baseUrl}/stb/${link}&typeaction=telechargement`,
        filename: `releve_${date}_${account.label}.pdf`
      }
    })
    return entries
  })
}

function saveAccountDocuments(entries, index, length) {
  // Give an equal time to fetch documents for each account
  // next documents will be downloaded for the next run
  const remainingTime = FULL_TIMEOUT - Date.now()
  const timeForThisAccount = remainingTime / (length - index)
  return saveFiles(entries, fields, {
    timeout: Date.now() + timeForThisAccount
  })
}

function fetchAndSaveAccountDocuments(account, index, length) {
  return fetchAccountDocuments(account, index).then(entries =>
    saveAccountDocuments(entries, index, length)
  )
}

function parseDate(date) {
  let mdate = moment(date, 'DD-MMM')
  if (!mdate.isValid()) {
    moment.locale('fr')
    mdate = moment(date + '.', 'DD-MMM')
    if (!mdate.isValid()) {
      moment.locale('en')
      mdate = moment(date + '.', 'DD-MMM')
      if (!mdate.isValid()) {
        log('warn', `Cannot parse date ${date}`)
      }
    }
  }

  return mdate
}

module.exports = {
  oldLogin,
  parseAccount,
  fetchOperations,
  parseOperations,
  fetchDocuments
}

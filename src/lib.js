const {
  log,
  requestFactory,
  errors,
  updateOrCreate,
  saveFiles,
  cozyClient
} = require('cozy-konnector-libs')
const groupBy = require('lodash/groupBy')
const omit = require('lodash/omit')
const xlsx = require('xlsx')
const bluebird = require('bluebird')
const moment = require('moment')
const url = require('url')
const regions = require('../regions.json')
const doctypes = require('cozy-doctypes')
const cheerio = require('cheerio')
const {
  Document,
  BankAccount,
  BankTransaction,
  BalanceHistory,
  BankingReconciliator
} = doctypes

// time given to the connector to save the files
const FULL_TIMEOUT = Date.now() + 4 * 60 * 1000

const request = requestFactory({
  // debug: true,
  jar: true,
  json: false,
  cheerio: true
})

const newRequest = requestFactory({
  // debug: true,
  jar: true,
  json: true,
  cheerio: false,
  resolveWithFullResponse: true,
  headers: {
    // For some reason, it only works with this user-agent, taken from weboob
    'User-Agent':
      'Mozilla/5.0 (X11; Linux x86_64; rv:60.0) Gecko/20100101 Firefox/60.0'
  }
})

let loginUrl = null
let baseUrl = null
let statementsUrl = null
let fields = {}

const bankLabel = 'Crédit Agricole'
const rootUrl = 'https://www.credit-agricole.fr'
const accountsUrl = 'particulier/acceder-a-mes-comptes.html'
const keypadUrl = 'particulier/acceder-a-mes-comptes.authenticationKeypad.json'
const securityCheckUrl =
  'particulier/acceder-a-mes-comptes.html/j_security_check'
const accountDetailsUrl =
  'particulier/operations/synthese/jcr:content.produits-valorisation.json'
const accountOperationsUrl =
  'particulier/operations/synthese/detail-comptes/jcr:content.n3.operations.json'
const label2Type = {
  'LIVRET A': 'bank',
  'COMPTE CHEQUE': 'bank',
  CCHQ: 'Checkings',
  PEL: 'Savings'
  // to complete when we have more data
}
let newSite = 0

Document.registerClient(cozyClient)

const reconciliator = new BankingReconciliator({
  BankAccount,
  BankTransaction
})

let lib

async function start(requiredFields) {
  fields = requiredFields
  const bankUrl = getBankUrl(fields.bankId)
  const accountsPage = await lib.login(bankUrl)
  let accounts = lib.parseAccounts(accountsPage)
  if (newSite) {
    await lib.getAccountsDetails(accounts, bankUrl)
  }
  log('info', `Found ${accounts.length} accounts`)
  let allOperations = []
  for (let account of accounts) {
    const operations = await syncOperations(account, bankUrl)
    log('info', `Found ${operations.length} operations`)
    allOperations = allOperations.concat(operations)
  }
  log('info', allOperations.slice(0, 5), 'operations[0:5]')
  const { accounts: savedAccounts } = await reconciliator.save(
    accounts.map(x => omit(x, ['linkOperations', 'caData'])),
    allOperations
  )
  const balances = await fetchBalances(savedAccounts)
  await lib.saveBalances(balances)
  if (newSite == 0) {
    await lib.fetchDocuments()
  }
}

function getBankUrl(bankId) {
  const bankUrl = regions[bankId]

  if (bankUrl === undefined) {
    log('error', `The bank id ${bankId} is unknown`)
    throw new Error(errors.LOGIN_FAILED)
  }

  log('info', `Bank url is ${bankUrl}`)
  return bankUrl
}

function cleanDocumentLabel(label) {
  // remove some special characters from the label
  return label
    .trim()
    .split(' ')
    .filter(l => l.length)
    .join('_')
    .replace('.', '')
}

function fetchDocuments() {
  log('info', 'Getting accounts statements')
  return fetchStatementPage()
    .then(parseStatementsPage)
    .then(accounts => bluebird.each(accounts, fetchAndSaveAccountDocuments))
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
      const label = cleanDocumentLabel(
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

function fillNewAccount(json) {
  return {
    institutionLabel: bankLabel,
    type: label2Type[json.libelleUsuelProduit.trim()] || 'UNKNOWN LABEL',
    label: json.libelleProduit.trim(),
    number: json.numeroCompteBam,
    vendorId: json.numeroCompteBam,
    balance: json.solde,
    caData: {
      category: json.grandeFamilleProduitCode,
      contrat: json.idElementContrat,
      devise: json.idDevise
    }
  }
}

function parseAccounts($) {
  log('info', 'Gettings accounts')

  if (newSite == 0) {
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
        type: label2Type[account[0]] || 'UNKNOWN LABEL',
        label: account[0],
        number: account[1],
        vendorId: account[1],
        balance: parseFloat(account[2].replace(' ', '').replace(',', '.')),
        linkOperations: operationsLink
      }
    })
  } else {
    const accountsJson = JSON.parse(
      cheerio
        .load($.body)('.Synthesis-main')
        .attr('data-ng-init')
        .match(/syntheseController.init\(({.*}),\s{.*}\)/)[1]
    )
    const accounts = []
    // Add main account
    accounts.push(fillNewAccount(accountsJson.comptePrincipal))
    accountsJson.grandesFamilles.forEach(x => {
      // Only keep 'placements', ignore 'assurances' and 'credits'
      if (x.titre === 'MES PLACEMENTS') {
        x.elementsContrats.forEach(element => {
          accounts.push(fillNewAccount(element))
        })
      }
    })
    return accounts
  }
}

async function getAccountsDetails(accounts, bankUrl) {
  for (let idx in accounts) {
    // Other accounts than the main accounts do not give the balance in JSON,
    // request account details to retrieve it
    if (
      typeof accounts[idx].balance === 'undefined' &&
      accounts[idx].caData.category
    ) {
      log('info', `Getting account #${idx} details`)
      await newRequest(
        `${bankUrl}/${accountDetailsUrl}/${accounts[idx].caData.category}`
      ).then($ => {
        $.body.forEach(element => {
          accounts.find(
            x => x.caData.contrat == element.idElementContrat
          ).balance = element.solde
        })
      })
    }
  }
}

function fetchStatementPage() {
  return request(statementsUrl)
}

async function syncOperations(account, bankUrl) {
  const rawOperations = await lib.fetchOperations(account, bankUrl)
  if (newSite == 0) {
    return lib.parseOperations(account, rawOperations)
  } else {
    return lib.parseNewOperations(account, rawOperations)
  }
}

async function fetchOperations(account, bankUrl) {
  log('info', `Gettings operations for ${account.label}`)

  if (newSite == 0) {
    const request = requestFactory({
      cheerio: false,
      jar: true
    })

    return request({
      url: `${baseUrl}/stb/${account.linkOperations}&typeaction=telechargement`,
      encoding: 'binary'
    })
  } else {
    let rawOperations = []

    const $ = await newRequest(`${bankUrl}/${accountOperationsUrl}`, {
      qs: {
        compteIdx: 0,
        grandeFamilleCode: account.caData.category,
        idElementContrat: account.caData.contrat,
        idDevise: account.caData.devise,
        count: 100
      }
    })

    $.body.listeOperations.forEach(x => {
      rawOperations.push(x)
    })

    let nextSetStartIndex = $.body.nextSetStartIndex
    let hasNext = $.body.hasNext

    while (hasNext) {
      const $ = await newRequest(`${bankUrl}/${accountOperationsUrl}`, {
        qs: {
          compteIdx: 0,
          grandeFamilleCode: account.caData.category,
          idElementContrat: account.caData.contrat,
          idDevise: account.caData.devise,
          startIndex: nextSetStartIndex,
          count: 100
        }
      })

      nextSetStartIndex = $.body.nextSetStartIndex
      hasNext = $.body.hasNext

      $.body.listeOperations.forEach(x => {
        rawOperations.push(x)
      })
    }

    return rawOperations
  }
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

function parseNewOperations(account, rawOperations) {
  let operations = []

  rawOperations.forEach(x => {
    operations.push({
      amount: x.montant,
      date: new Date(x.dateValeur),
      dateOperation: new Date(x.dateOperation),
      label: x.libelleOperation.trim(),
      dateImport: new Date(),
      currency: x.idDevise,
      vendorAccountId: account.number,
      type: 'none' // TODO Map libelleTypeOperation to type
    })
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

function login(bankUrl) {
  log('info', 'Try to login with old scheme')
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
        return newlogin(bankUrl)
      } else {
        log('error', `Status code: ${$.statusCode}`)
        throw new Error(errors.VENDOR_DOWN)
      }
    })
}

function newlogin(bankUrl) {
  log('info', 'Try to login with new scheme')
  return newRequest(`${bankUrl}/${accountsUrl}`).then($ => {
    // Get the form data to post
    let form = []
    cheerio
      .load($.body)('form[id=loginForm]')
      .serializeArray()
      .map(x => (form[x.name] = x.value))
    // Request a secure keypad
    return newRequest(`${bankUrl}/${keypadUrl}`, {
      method: 'POST',
      // Set a referer and the login in the body, necessary with this user-agent
      headers: {
        Referer: `${bankUrl}/${accountsUrl}`
      },
      body: {
        user_id: fields.login
      }
    })
      .then($ => {
        // Extract password and keypad id
        const keypadPassword = Array.from(fields.password)
          .map(digit => {
            return $.body.keyLayout.indexOf(digit)
          })
          .toString()

        return {
          keypadPassword: keypadPassword,
          keypadId: $.body.keypadId
        }
      })
      .then(secureForm => {
        // Fill and post login form
        form['j_username'] = fields.login
        form['j_password'] = secureForm['keypadPassword']
        form['keypadId'] = secureForm['keypadId']
        return newRequest(`${bankUrl}/${securityCheckUrl}`, {
          method: 'POST',
          form: form
        })
          .then($ => {
            newSite = 1
            return newRequest(`${rootUrl}${$.body.url}`)
          })
          .catch($ => {
            if ($.statusCode == 500) {
              log('error', $.error.error.message)
              if (
                $.error.error.message.includes(
                  'Votre identification est incorrecte'
                )
              ) {
                throw new Error(errors.LOGIN_FAILED)
              } else if (
                $.error.error.message.includes('Un incident technique')
              ) {
                throw new Error(errors.VENDOR_DOWN)
              } else {
                throw new Error(errors.LOGIN_FAILED)
              }
            } else {
              log('error', $.message)
              throw new Error(errors.LOGIN_FAILED)
            }
          })
      })
  })
}

function fetchBalances(accounts) {
  const now = moment()
  const todayAsString = now.format('YYYY-MM-DD')
  const currentYear = now.year()

  return Promise.all(
    accounts.map(async account => {
      const history = await BalanceHistory.getByYearAndAccount(
        currentYear,
        account._id
      )
      history.balances[todayAsString] = account.balance

      return history
    })
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

function saveBalances(balances) {
  return updateOrCreate(balances, 'io.cozy.bank.balancehistories', ['_id'])
}

module.exports = lib = {
  start,
  parseAccounts,
  getAccountsDetails,
  saveBalances,
  fetchOperations,
  parseOperations,
  parseNewOperations,
  syncOperations,
  fetchDocuments,
  login
}

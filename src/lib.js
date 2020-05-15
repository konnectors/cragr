const {
  log,
  requestFactory,
  errors,
  updateOrCreate,
  //saveFiles,
  cozyClient
} = require('cozy-konnector-libs')
const groupBy = require('lodash/groupBy')
const omit = require('lodash/omit')
//const bluebird = require('bluebird')
const moment = require('moment')
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

const helpers = require('./helpers')
const libOldSite = require('./lib_oldsite')

// time given to the connector to save the files
//const FULL_TIMEOUT = Date.now() + 4 * 60 * 1000

/*
const request = requestFactory({
  // debug: true,
  jar: true,
  json: false,
  cheerio: true
})*/

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

//let baseUrl = null
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
    await libOldSite.fetchDocuments()
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

function fillNewAccount(json) {
  return {
    institutionLabel: bankLabel,
    type: helpers.getAccountType(json.libelleUsuelProduit.trim()),
    label: json.libelleProduit.trim(),
    number: json.numeroCompteBam,
    vendorId: json.numeroCompteBam,
    balance: json.solde,
    caData: {
      index: json.index,
      category: json.grandeFamilleProduitCode,
      contrat: json.idElementContrat,
      devise: json.idDevise
    }
  }
}

function parseAccounts($) {
  log('info', 'Gettings accounts')

  if (newSite == 0) return libOldSite.parseAccount($)

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
    // ignore 'MES ASSURANCES'
    // then keep 'MES COMPTES' 'MES PLACEMENTS' 'MON EPARGNE DISPONIBLE' 'MES CREDITS'
    if (x.titre !== 'MES ASSURANCES') {
      x.elementsContrats.forEach(element => {
        // if we want ignore mandatory account, then ignore them
        if (
          !(
            element.rolePartenaireCalcule === 'MANDATAIRE' &&
            fields.ignoreMandatoryAccount
          )
        ) {
          accounts.push(fillNewAccount(element))
        }
      })
    }
  })
  return accounts
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
          ).balance = helpers.getBalance(element, fields.countWithInterest)
        })
      })
    }
  }
}

async function syncOperations(account, bankUrl) {
  if (newSite == 0) {
    const rawOperations = await libOldSite.fetchOperations(account, bankUrl)
    return libOldSite.parseOperations(account, rawOperations)
  } else {
    const rawOperations = await lib.fetchOperations(account, bankUrl)
    return lib.parseNewOperations(account, rawOperations)
  }
}

/**
 * get operation for website with new site version
 *
 * @param account
 * @param bankUrl
 * @returns {Promise<[]>}
 */
async function fetchOperations(account, bankUrl) {
  log('info', `Gettings operations for ${account.label}`)

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

async function login(bankUrl) {
  log('info', 'Try to login ...')

  const oldLogin = await libOldSite.oldLogin(bankUrl, fields)

  if (oldLogin === null) {
    return newlogin(bankUrl)
  }
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
              if ($.error.url && $.error.url.includes('dsp2')) {
                log('error', 'Strong authentication necessary')
                throw new Error(errors.USER_ACTION_NEEDED)
              } else {
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

function saveBalances(balances) {
  return updateOrCreate(balances, 'io.cozy.bank.balancehistories', ['_id'])
}

module.exports = lib = {
  start,
  parseAccounts,
  getAccountsDetails,
  saveBalances,
  fetchOperations,
  parseNewOperations,
  syncOperations,
  //fetchDocuments,
  login
}

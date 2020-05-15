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
const bluebird = require('bluebird')
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
const FULL_TIMEOUT = Date.now() + 12 * 60 * 1000

const request = requestFactory({
  // debug: true,
  jar: true,
  json: false,
  cheerio: true
})

const requestJson = requestFactory({
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

let baseUrl = null
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
const documentsUrl = {
  getForm: 'particulier/operations/documents/edocuments.html',
  getToken: 'libs/granite/csrf/token.json'
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
  baseUrl = bankUrl
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

  // accounts + operations
  const { accounts: savedAccounts } = await reconciliator.save(
    accounts.map(x => omit(x, ['linkOperations', 'caData'])),
    allOperations
  )

  // balances
  const balances = await fetchBalances(savedAccounts)
  await lib.saveBalances(balances)

  // docs
  if (newSite == 0) await libOldSite.fetchDocuments()
  else await lib.fetchDocuments()
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

/**
 * call this function for get every documents fr
 *
 * @returns {Q.Promise<any> | Promise<void> | PromiseLike<any>}
 */
function fetchDocuments() {
  log('info', 'Getting accounts statements and another documents')

  // get form with identifiantBAM
  return request(`${baseUrl}/${documentsUrl.getForm}`).then($ => {
    const form = $('form[name="formulaire"]')
    const linkPost = helpers.getLinkWithoutBankId(form.attr('action'))

    //log('debug', linkPost, 'linkPost')

    // get token
    return requestJson(`${baseUrl}/${documentsUrl.getToken}`, {
      headers: {
        Referer: `Referer: ${baseUrl}/${documentsUrl.getForm}`
      }
    }).then($ => {
      //log('debug', $.body.token, 'Token')

      const csrf_token = $.body.token

      // get doc page
      return request(`${baseUrl}/${linkPost}`, {
        headers: {
          Referer: `Referer: ${baseUrl}/${documentsUrl.getForm}`
        },
        method: 'POST',
        form: {
          largeur_ecran: '800',
          hauteur_ecran: '600',
          ':cq_csrf_token': csrf_token
        }
      })
        .then(
          parseStatementsPage
        ) /*
        .catch($ => {
          log(
            'debug',
            $.statusCode,
            'Error, can not get documents | status code'
          )
        })*/
        .then(linkFilesOrDetails =>
          bluebird.each(linkFilesOrDetails, fetchAndSaveDocuments)
        )
    })
  })
}

/**
 * this function is called when document page is finded
 * (can find every files)
 *
 * @param $
 * @returns {[]|*[]}
 */
function parseStatementsPage($) {
  //log('debug', $, '$')
  log('info', 'Parsing documents page')

  //if can not find in page
  if ($('#entete1').length === 0) {
    log('warning', 'No document find')
    return []
  }

  // init
  let linksFilesOrDetails = []

  for (
    var indexPanneau = 1, length = 16;
    indexPanneau <= length;
    indexPanneau++
  ) {
    // for every categories
    Array.from($('#panneau' + indexPanneau)).forEach(divCategorie => {
      // for every sub categories

      const $divCategorie = $(divCategorie) // elem to jquery

      const $subCategories_title = $divCategorie.find('.encart-2')
      const $subCategories_contents = $divCategorie.find('table')
      const nbSubCategories = $subCategories_title.length

      for (var index = 0; index < nbSubCategories; index++) {
        const title = $subCategories_title.eq(index).text()
        const $contents = $subCategories_contents.eq(index)

        // init
        let labelAccount = ''

        //log('debug', title, 'title')
        //log('warn', $contents.find('tbody').length, 'tbody length')
        //log('warn', $contents.find('tbody').eq(0).text(), 'tbody text')
        //log('warn', $contents.find('tbody').eq(0).find('tr').length, 'tr length')

        Array.from(
          $contents
            .find('tbody')
            .eq(0)
            .find('tr')
        ).forEach(tr => {
          //log('debug', tr, 'tr')

          const $tr = $(tr) // elem to jquery

          //log('warn', $tr.find('.entete-table-compte-repliable').length, '.entete-table-compte-repliable length')
          //log('warn', $tr.text(), 'tr text')

          // list
          if ($tr.find('.entete-table-compte-repliable').length > 0) {
            //log('debug', 'tr list')

            const $div = $tr.find('.entete-table-compte-repliable')

            const link = helpers.getLinkWithoutBankId(
              $div.find('.fleche-ouvrir').attr('href')
            )

            labelAccount = helpers.cleanDocumentLabel(
              $div
                .find('a')
                .eq(1)
                .text()
            )

            linksFilesOrDetails.push({
              isFile: false,
              panelId: '#panneau' + indexPanneau,
              type: helpers.parseDocumentType(title),
              account: labelAccount,
              link: `${baseUrl}/${link}`
            })
          }
          // direct
          else {
            //log('debug', 'tr direct');

            const $cells = $tr.find('td')
            const date = helpers.parseDate($cells.eq(0).text())
            const link = helpers.parseUrlDownload($cells.eq(3).find('a'))
            const name = $tr
              .find('th')
              .eq(0)
              .text()
              .trim()

            linksFilesOrDetails.push({
              isFile: true,
              type: helpers.parseDocumentType(title),
              account: labelAccount,
              link: `${baseUrl}/${link}`,
              date: date,
              name: name
            })
          }
        })
      }
    })
  }

  //log('debug', linksFilesOrDetails, 'list of files or details with their links')

  return linksFilesOrDetails
}

/**
 * this function is called when document page is parsed
 *
 * @param linkFileOrDetails (contains file link or detail link)
 * @param index
 * @param length
 * @returns {Q.Promise<any> | Promise<void> | PromiseLike<any>}
 */
function fetchAndSaveDocuments(linkFileOrDetails, index, length) {
  //log('debug', linkFileOrDetails, 'linkFileOrDetails')
  //log('debug', index, 'index')
  //log('debug', length, 'length')

  /**
   * parse every return in promise for get real links (when is detail)
   * and call function for save them
   */
  return fetchLinksDocuments(linkFileOrDetails).then(files =>
    saveDocuments(files, index, length)
  )
}

/**
 * get file name/url for every file or details
 *
 * @param linkFileOrDetails
 * @returns {Q.Promise<any> | Promise<{filename: string, fileurl: string}[]> | PromiseLike<{filename: string, fileurl: string}[]>}
 */
function fetchLinksDocuments(linkFileOrDetails) {
  //log('debug', linkFileOrDetails, 'linkFileOrDetails')
  // if is file, then return him directly
  if (linkFileOrDetails.isFile) {
    const accountDir =
      linkFileOrDetails.account !== '' ? `/${linkFileOrDetails.account}` : ''
    return Promise.resolve([
      {
        fileurl: `${linkFileOrDetails.link}&typeaction=telechargement`,
        subPath: `${linkFileOrDetails.type}${accountDir}`,
        filename: `${linkFileOrDetails.date}_${linkFileOrDetails.name} (${accountDir}).pdf`
        // filename have ($accountDir) because it's make error if two file have same name
      }
    ])
  }

  // if is details then get files :

  return request(linkFileOrDetails.link).then($ => {
    log('info', linkFileOrDetails.account, 'get details for')
    //log('debug', linkFileOrDetails, 'get details for')
    //log('debug', $, '$')

    // now get all the links to the releves of this account
    log(
      'warn',
      $(linkFileOrDetails.panelId + ' tr[title][id]').length,
      'nb documents'
    )
    return Array.from($(linkFileOrDetails.panelId + ' tr[title][id]')).map(
      elem => {
        const $cells = $(elem).find('td')
        const date = helpers.parseDate($cells.eq(0).text())
        const link = helpers.parseUrlDownload($cells.eq(3).find('a'))
        const name = $(elem)
          .find('th')
          .eq(0)
          .text()
          .trim()

        const accountDir =
          linkFileOrDetails.account !== ''
            ? `/${linkFileOrDetails.account}`
            : ''

        return {
          fileurl: `${baseUrl}/${link}&typeaction=telechargement`,
          subPath: `${linkFileOrDetails.type}${accountDir}`,
          filename: `${date}_${name} (${accountDir}).pdf`
          // filename have ($accountDir) because it's make error if two file have same name
        }
      }
    )
  })
}

/**
 * save every files
 *
 * @param files
 * @param index
 * @param length
 * @returns {*|Promise<[]>}
 */
function saveDocuments(files, index, length) {
  log('debug', files, 'Save files')

  // nothing to save
  if (files.length === 0) {
    return null
  }

  // Give an equal time to fetch documents for each account
  // next documents will be downloaded for the next run
  const remainingTime = FULL_TIMEOUT - Date.now()
  const timeForThisAccount = remainingTime / (length - index)
  return saveFiles(files, fields, {
    timeout: Date.now() + timeForThisAccount
  })
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
      await requestJson(
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
  let nextSetStartIndex = null
  let hasNext = false
  let pageIndex = 1

  do {
    log(
      'debug',
      pageIndex,
      'Gettings operations for ${account.label} inside page '
    )

    let qs = {
      compteIdx: account.caData.index,
      grandeFamilleCode: account.caData.category,
      idElementContrat: account.caData.contrat,
      idDevise: account.caData.devise,
      count: 100
    }

    if (nextSetStartIndex !== null) qs.startIndex = nextSetStartIndex

    const $ = await requestJson(`${bankUrl}/${accountOperationsUrl}`, {
      qs: qs
    })

    $.body.listeOperations.forEach(x => {
      rawOperations.push(x)
    })

    nextSetStartIndex = $.body.nextSetStartIndex
    hasNext = $.body.hasNext

    pageIndex++
  } while (hasNext)

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
  return requestJson(`${bankUrl}/${accountsUrl}`).then($ => {
    // Get the form data to post
    let form = []
    cheerio
      .load($.body)('form[id=loginForm]')
      .serializeArray()
      .map(x => (form[x.name] = x.value))
    // Request a secure keypad
    return requestJson(`${bankUrl}/${keypadUrl}`, {
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
        return requestJson(`${bankUrl}/${securityCheckUrl}`, {
          method: 'POST',
          form: form
        })
          .then($ => {
            newSite = 1
            return requestJson(`${rootUrl}${$.body.url}`)
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
  fetchDocuments,
  login
}

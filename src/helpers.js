//const moment = require('moment')
//const rerrors = require('request-promise/errors')
//const { log, errors } = require('cozy-konnector-libs')

// ====== Constants =======

const AccountType = {
  CHECKINGS: 'Checkings',
  SAVINGS: 'Savings',
  CARD: 'CreditCard',
  MARKET: 'Market',
  PEA: 'PEA',
  LIFE_INSURANCE: 'LifeInsurance',
  CREDIT: 'ConsumerCredit'
}

const AbbrToAccountType = {
  CCHQ: AccountType.CHECKINGS,
  'LIV A': AccountType.SAVINGS,
  LDD: AccountType.SAVINGS,
  PEL: AccountType.SAVINGS,
  'CAP DECOUV': AccountType.LIFE_INSURANCE,
  CPS: AccountType.MARKET,
  'P. ACC.SOC': AccountType.CREDIT
}

// ====== Public functions =======

/**
 * Analyzes the URL of the bank account to find its type
 *
 * @param {string} label The label of the bank account
 * @see {@link https://docs.cozy.io/en/cozy-doctypes/docs/io.cozy.bank/#iocozybankaccounts|io.cozy.bank.accounts}
 * @returns {string} The type of the bank account
 */
function getAccountType(label) {
  //log('debug', label, 'getAccountType() label')

  return AbbrToAccountType[label] || 'Unknown'
}

function getBalance(element, countWithInterest) {
  // balance is not same index for every type of accounts
  if (element.solde !== undefined) return element.solde // standard account
  if (element.encoursActuel !== undefined) return element.encoursActuel // assurance vie
  if (element.valorisationContrat !== undefined)
    return element.valorisationContrat // compte part sociale

  if (element.montantRestantDu !== undefined) {
    // credit
    if (countWithInterest !== null && countWithInterest === '1') {
      //TODO
    }

    return element.montantRestantDu * -1
  }
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

function getLinkWithoutBankId(url) {
  return url
    .split('/')
    .splice(2)
    .join('/')
}

function parseDate(text) {
  return text
    .trim()
    .split('/')
    .reverse()
    .join('-')
}

function parseUrlDownload($a) {
  var link = $a
    .attr('href')
    .split(';')[1]
    .match(/\('(.*)'\)/)[1]

  return getLinkWithoutBankId(link)
}

function parseDocumentType(type) {
  return type.trim().replace(/\s+/g, '_')
}

// ====== Export =======

module.exports = {
  AbbrToAccountType,
  getAccountType,
  getBalance,
  cleanDocumentLabel,
  getLinkWithoutBankId,
  parseDate,
  parseUrlDownload,
  parseDocumentType
}

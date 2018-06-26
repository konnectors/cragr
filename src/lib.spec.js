const path = require('path')
const fs = require('fs')
const cheerio = require('cheerio')
const xlsx = require('xlsx')
const { Document, BankTransaction, BankAccount } = require('cozy-doctypes')
const lib = require('./lib')

describe('sync', () => {
  beforeEach(() => {
    let id = 1
    const fakeCreate = attrs => Promise.resolve({ ...attrs, _id: id++ })
    Document.createOrUpdate = jest.fn().mockImplementation(fakeCreate)
    BankAccount.createOrUpdate = jest.fn().mockImplementation(fakeCreate)
    BankTransaction.createOrUpdate = jest.fn().mockImplementation(fakeCreate)
    const accountsHTML = cheerio.load(
      fs.readFileSync(path.join(__dirname, './__tests__/accounts.html'))
    )
    const workbook = xlsx.readFile(
      path.join(__dirname, './__tests__/workbook.xlsx')
    )
    lib.login = jest.fn().mockReturnValue(Promise.resolve(accountsHTML))
    lib.saveBalances = jest.fn().mockReturnValue(Promise.resolve())
    lib.fetchOperations = jest.fn().mockReturnValue(Promise.resolve(workbook))
    lib.fetchDocuments = jest.fn().mockReturnValue(Promise.resolve([]))
  })

  it('should correctly sync accounts/operations/histories', async () => {
    BankAccount.fetchAll = jest.fn().mockReturnValue(Promise.resolve([]))
    BankTransaction.getMostRecentForAccounts = jest
      .fn()
      .mockReturnValue(Promise.resolve([]))
    await lib.start({
      login: 'fakelogin',
      password: 'fakepassword',
      bankId: '20'
    })
    expect(BankAccount.createOrUpdate.mock.calls).toMatchSnapshot()
    expect(BankTransaction.createOrUpdate.mock.calls).toMatchSnapshot()
  })

  it('should correctly sync accounts/operations/histories', async () => {
    BankAccount.fetchAll = jest.fn().mockReturnValue(
      Promise.resolve([
        {
          _id: 123,
          vendorId: '65002241337',
          number: '65002241337',
          balance: 1000,
          label: 'Existing account'
        }
      ])
    )
    BankTransaction.getMostRecentForAccounts = jest.fn().mockReturnValue(
      Promise.resolve([
        {
          account: 123,
          vendorId: '65002241337_2017-12-28_0',
          date: '2017-12-28T00:00:00',
          amount: 100
        }
      ])
    )
    await lib.start({
      login: 'fakelogin',
      password: 'fakepassword',
      bankId: '20'
    })

    expect(BankAccount.createOrUpdate.mock.calls).toMatchSnapshot()

    // only transactions from 28/12/2017 are saved
    expect(BankTransaction.createOrUpdate.mock.calls).toMatchSnapshot(13)
  })
})

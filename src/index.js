const { BaseKonnector } = require('cozy-konnector-libs')
const { start } = require('./lib')

module.export = new BaseKonnector(start)

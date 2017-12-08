const {BaseKonnector} = require('cozy-konnector-libs')

module.export = new BaseKonnector(start)

function start (fields) {
  console.log('hello world')
}

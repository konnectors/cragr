const request = require('request-promise')
const cheerio = require('cheerio')
const fs = require('fs')
const path = require('path')

console.log('Getting the list of regions and the corresponding urls')

request('https://www.credit-agricole.fr').then(body => {
  const $ = cheerio.load(body)
  const script = Array.from($('script')).find(script => {
    return $(script)
      .html()
      .includes('CR_infos_v2')
  })

  if (!script) {
    throw new Error('Failed to get the list of available banks')
  }

  const assoc = JSON.parse(
    $(script)
      .html()
      .match(/= ({.*});/)[1]
  )
  const result = {}
  const manifestConfig = []
  for (let key in assoc) {
    result[assoc[key].id_caisse] = assoc[key].url
    manifestConfig.push({
      name: assoc[key].nom,
      value: assoc[key].id_caisse
    })
  }

  const regionFilePath = path.join(__dirname, '../regions.json')
  fs.writeFileSync(regionFilePath, JSON.stringify(result, null, 2))

  console.log(`The list of regions is written in ${regionFilePath}`)

  manifestConfig.sort((a, b) => a.name.localeCompare(b.name))
  const manifestFilePath = path.join(__dirname, '../manifestConfig.json')
  fs.writeFileSync(manifestFilePath, JSON.stringify(manifestConfig, null, 2))

  console.log(`The manifest configuration is written in ${manifestFilePath}`)
})

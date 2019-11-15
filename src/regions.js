/* eslint no-console: off */

const request = require('request-promise')
const cheerio = require('cheerio')
const fs = require('fs')
const path = require('path')

console.log('Getting the list of regions and the corresponding urls')

request('https://www.credit-agricole.fr/particulier/acces-cr.html').then(
  body => {
    const $ = cheerio.load(body)
    const script = Array.from($('script')).find(script => {
      return $(script)
        .html()
        .includes('regionalBankId')
    })

    if (!script) {
      throw new Error('Failed to get the list of available banks')
    }

    let re = /NPC.listCr\[\d+\] = {regionalBankId: \d+, regionalBankName: "(.*)", regionalBankUrlPrefix: "\/(.*)\/" };/g
    let m
    const cr = []
    do {
      m = re.exec($(script).html())
      if (m) {
        let name = m[1]
        // Dirty hacks to keep the CR indexes retrocompatibility
        if (name === 'Paris') name = 'Île-de-France'
        if (name === 'Nord Est') name = 'Nord-Est'
        cr.push({
          name: name,
          prefix: m[2]
        })
      }
    } while (m)

    cr.sort((a, b) => a.name.localeCompare(b.name))

    let index = 1
    const regionPrefix = {}
    const manifestConfig = []
    for (const value of cr) {
      regionPrefix[index] = 'https://www.credit-agricole.fr/' + value.prefix
      manifestConfig.push({
        name: value.name,
        value: index.toString()
      })
      index++
    }

    const regionFilePath = path.join(__dirname, '../regions.json')
    fs.writeFileSync(regionFilePath, JSON.stringify(regionPrefix, null, 2))

    console.log(`The list of regions is written in ${regionFilePath}`)

    manifestConfig.sort((a, b) => a.name.localeCompare(b.name))
    const manifestFilePath = path.join(__dirname, '../manifestConfig.json')
    fs.writeFileSync(manifestFilePath, JSON.stringify(manifestConfig, null, 2))

    console.log(`The manifest configuration is written in ${manifestFilePath}`)
  }
)

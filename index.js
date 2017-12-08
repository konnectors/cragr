const {BaseKonnector, log, request, errors} = require('cozy-konnector-libs')

const rq = request({
  // debug: true,
  jar: true,
  json: false,
  cheerio: true
})

let loginUrl = null

module.export = new BaseKonnector(start)

function start (fields) {
  return login(fields)
  .then($ => {
    const comptes = Array.from($('.ca-table tbody tr img'))
      .map(compte => $(compte).closest('tr'))
      .map(compte => Array.from($(compte).find('td'))
          .map(td => {
            const $td = $(td)
            let text = $td.text().trim()

            // Get the full label of the account which is onmouseover event
            const mouseover = $td.attr('onmouseover') || ''
            let fullText = mouseover.match(/'(.*)'/)
            if (fullText) text = fullText[1]

            return text
          })
          .filter(td => td.length > 0)
      )

    console.log(comptes.map(compte => ({
      label: compte[0],
      number: compte[1],
      amount: Number(compte[2].replace(' ', '').replace(',', '.'))
    })))
  })
}

function login (fields) {
  log('info', 'Logging in')
  return rq('https://www.ca-paris.fr/particuliers.html')
  .then($ => {
    const script = Array.from($('script'))
      .map(script => $(script).html().trim())
      .find(script => {
        return script.match(/var chemin = "/)
      })

    loginUrl = script.match(/var chemin = "(.*)".*\|/)[1]

    return rq({
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
    const touches = Array.from($('#pave-saisie-code td a')).filter(touche => $(touche).text().trim() !== '')
    const decodeTable = touches.reduce((memo, touche) => {
      const $touche = $(touche)
      memo[$touche.text().trim()] = $touche.closest('td').attr('onclick').match(/'(.*)'/)[1]
      return memo
    }, {})

    const password = fields.password.split('').map(nb => decodeTable[nb]).join(',')

    return rq({
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
    if ($('.ca-table tbody tr img').length) {
      log('info', 'LOGIN_OK')
      return $
    } else {
      throw new Error(errors.LOGIN_FAILED)
    }
  })
}

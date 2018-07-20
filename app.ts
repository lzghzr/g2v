import fs from 'fs'
import request from 'request'
import protobuf from 'protobufjs'

const gfwlistUrl = 'https://github.com/gfwlist/gfwlist/raw/master/gfwlist.txt'

request.get(gfwlistUrl, (error, response) => {
  if (error !== null) return console.error(error)
  // 解码
  const gfwlist = Buffer.from(response.body, 'base64').toString()
  fs.writeFile('./build/gfwlist.txt', gfwlist, error => { if (error !== null) console.log(error) })
  // 格式化
  const gfwlist2v = parseGFWListRules(gfwlist)
  // 写入json
  const rules = Object.keys(gfwlist2v)
    .map(key => ({ type: 'field', domain: gfwlist2v[key].map(domain => parseDomain2json(domain)), 'outboundTag': key }))
  fs.writeFile('./build/gfwlist.json', JSON.stringify(rules), error => { if (error !== null) console.log(error) })
  // 写入pb
  protobuf.load('./router.proto').then(protoRoot => {
    const GeoSiteList = protoRoot.lookupType('router.GeoSiteList')
    const siteList = GeoSiteList.create({
      entry: Object.keys(gfwlist2v)
        .map(key => ({ countryCode: key.toUpperCase(), domain: gfwlist2v[key].map(domain => parseDomain2pb(domain)) }))
    })
    const buffer = GeoSiteList.encode(siteList).finish()
    fs.writeFile('./build/gfwlist', buffer, error => { if (error !== null) console.log(error) })
  })
})
/**
 * 匹配类型
 *
 * @enum {number}
 */
enum v2Type {
  'plain',
  'regex',
  'domain'
}
interface v2Rule {
  type: number
  value: string
}
/**
 * 格式化GFWList
 *
 * @param {string} gfwlist
 * @returns {{ [index: string]: string[] }}
 */
function parseGFWListRules(gfwlist: string): { [index: string]: v2Rule[] } {
  const direct: v2Rule[] = []
  const proxy: v2Rule[] = []
  const lines = gfwlist.split('\n')
  // 补充内容, 非域名, 无法实现
  let supplemental = false
  lines.forEach(line => {
    if (line.includes('Supplemental List Start')) supplemental = true
    else if (line.includes('Supplemental List End')) supplemental = false
    if (line === '' || line.startsWith('!') || line.startsWith('[')) return
    // 域名及其子域
    if (line.startsWith('||')) {
      line = getDomain(line.substr(2))
      if (line !== '' && !proxy.find(rule => rule.value === line)) proxy.push({ type: v2Type.domain, value: line })
    }
    // 不匹配子域
    else if (line.startsWith('|')) {
      line = getDomain(line.substr(1))
      if (line !== '' && !proxy.find(rule => rule.value === line)) proxy.push({ type: v2Type.regex, value: line })
    }
    // 白名单
    else if (line.startsWith('@@')) {
      line = line.substr(2)
      // 域名及其子域
      if (line.startsWith('||')) {
        line = getDomain(line.substr(2))
        if (line !== '' && !direct.find(rule => rule.value === line)) direct.push({ type: v2Type.domain, value: line })
      }
      // 不匹配子域
      else if (line.startsWith('|')) {
        line = getDomain(line.substr(1))
        if (line !== '' && !direct.find(rule => rule.value === line)) direct.push({ type: v2Type.regex, value: line })
      }
    }
    else if (line.startsWith('/')) {
      // 正则太少, 暂不实现
      console.log('regex', line)
    }
    else if (!supplemental) {
      line = getDomain(line)
      if (line !== '' && !proxy.find(rule => rule.value === line)) proxy.push({ type: v2Type.plain, value: line })
    }
    // 关键字匹配, 无法使用域名实现
    else console.log('other', line)
  })
  return { direct, proxy }
}
/**
 * 提取域名
 *
 * @param {string} url
 * @returns
 */
function getDomain(url: string) {
  url = url.trim()
  url = decodeURIComponent(url)
  url = url.replace(/^https?:\/\//, '')
  const i = url.indexOf('/')
  if (i > 0) {
    // 排除非域名规则
    if (url.length > i + 1) {
      console.log('notdomain', url)
      return ''
    }
    url = url.substr(0, i)
  }
  if (!url.includes('.')) {
    console.log('unknown', url)
    return ''
  }
  if (url.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/) !== null) {
    console.log('ip', url)
    return ''
  }
  return url
}
/**
 * 格式化域名, json
 *
 * @param {v2Rule} domain
 * @returns {string}
 */
function parseDomain2json(domain: v2Rule): string {
  if (domain.type === v2Type.regex) domain.value = 'regexp:^' + domain.value.replace(/\./g, '\\.').replace(/\*/g, '\\S*')
  else if (domain.value.includes('*')) domain.value = 'regexp:' + domain.value.replace(/\./g, '\\.').replace(/\*/g, '.*')
  else if (domain.type === v2Type.domain) domain.value = 'domain:' + domain.value
  return domain.value
}
/**
 * 格式化域名, pb
 *
 * @param {string} domain
 * @returns {v2Rule}
 */
function parseDomain2pb(domain: v2Rule): v2Rule {
  if (domain.type === v2Type.regex) domain.value = '^' + domain.value.replace(/\./g, '\\.').replace(/\*/g, '\\S*')
  else if (domain.value.includes('*')) {
    domain.type = v2Type.regex
    domain.value = domain.value.replace(/\./g, '\\.').replace(/\*/g, '.*')
  }
  return domain
}
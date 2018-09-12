import fs from 'fs'
import request from 'request'
import protobuf from 'protobufjs'

const gfwlistUrl = 'https://github.com/gfwlist/gfwlist/raw/master/gfwlist.txt'

request.get(gfwlistUrl, (error, response) => {
  if (error !== null) return console.error(error)
  // 解码
  const gfwlist = Buffer.from(response.body, 'base64').toString()
  fs.writeFile(__dirname + '/gfwlist.txt', gfwlist, error => { if (error !== null) console.log(error) })
  // 格式化
  const gfwlist2v = parseGFWListRules(gfwlist)
  // 写入json
  const rules = Object.keys(gfwlist2v)
    .map(key => ({ type: 'field', domain: parseDomain2json(gfwlist2v[key]), 'outboundTag': key }))
  fs.writeFile(__dirname + '/gfwlist.json', JSON.stringify(rules, (_key, value) => value, 2), error => { if (error !== null) console.log(error) })
  // 写入pb
  protobuf.load('./router.proto').then(protoRoot => {
    const GeoSiteList = protoRoot.lookupType('router.GeoSiteList')
    const siteList = GeoSiteList.create({
      entry: Object.keys(gfwlist2v)
        .map(key => ({ countryCode: key.toUpperCase(), domain: parseDomain2pb(gfwlist2v[key]) }))
    })
    const buffer = GeoSiteList.encode(siteList).finish()
    fs.writeFile(__dirname + '/gfwlist', buffer, error => { if (error !== null) console.log(error) })
  })
})
/**
 * 匹配类型
 *
 * @enum {number}
 */
enum v2Type {
  'plain',
  'regexp',
  'domain',
  'full'
}
interface v2Rule {
  [index: number]: Set<string>
}
interface v2RulePB {
  type: number
  value: string
}
/**
 * 格式化GFWList
 *
 * @param {string} gfwlist
 * @returns {{ [index: string]: v2Rule }}
 */
function parseGFWListRules(gfwlist: string): { [index: string]: v2Rule } {
  const direct: v2Rule = {
    [v2Type.full]: new Set(),
    [v2Type.domain]: new Set(),
    [v2Type.regexp]: new Set(),
    [v2Type.plain]: new Set()
  }
  const proxy: v2Rule = {
    [v2Type.full]: new Set(),
    [v2Type.domain]: new Set(),
    [v2Type.regexp]: new Set(),
    [v2Type.plain]: new Set()
  }
  const lines = gfwlist.split('\n')
  let skip = false
  lines.forEach(line => {
    if (line.includes('Supplemental List Start') || line.includes('Whitelist Start')) skip = true
    else if (line.includes('Supplemental List End') || line.includes('Whitelist End')) skip = false
    if (line === '' || line.startsWith('!') || line.startsWith('[')) return
    if (skip) return console.log('skip', line)
    // 域名及其子域
    if (line.startsWith('||')) {
      line = getDomain(line.substr(2))
      if (line !== '') domainAdd(line, proxy)
    }
    // 不匹配子域
    else if (line.startsWith('|')) {
      line = getDomain(line.substr(1))
      if (line !== '') fullAdd(line, proxy)
    }
    // 白名单
    else if (line.startsWith('@@')) {
      line = line.substr(2)
      // 域名及其子域
      if (line.startsWith('||')) {
        line = getDomain(line.substr(2))
        if (line !== '') domainAdd(line, direct)
      }
      // 不匹配子域
      else if (line.startsWith('|')) {
        line = getDomain(line.substr(1))
        if (line !== '') fullAdd(line, direct)
      }
      else if (line.startsWith('/')) {
        // 正则太少, 暂不实现
        console.log('regex', line)
      }
      else {
        line = getDomain(line)
        if (line !== '') plainAdd(line, direct)
      }
    }
    else if (line.startsWith('/')) {
      // 正则太少, 暂不实现
      console.log('regex', line)
    }
    else {
      line = getDomain(line)
      if (line !== '') plainAdd(line, proxy)
    }
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
 * 添加domain规则
 *
 * @param {string} line
 * @param {v2Rule} rule
 */
function domainAdd(line: string, rule: v2Rule) {
  if (line.includes('*')) {
    const lineMatch = line.match(/\*.*?\.(.+)/)
    if (lineMatch === null) return console.log('unknow', line)
    if (!rule[v2Type.domain].has(lineMatch[1])) {
      line = line.replace(/\./g, '\\.').replace(/\*/g, '[^\\.]+') + '$'
      rule[v2Type.regexp].add(line)
    }
  }
  else {
    if (rule[v2Type.full].has(line)) rule[v2Type.full].delete(line)
    rule[v2Type.domain].add(line)
  }
}
/**
 * 添加full规则
 *
 * @param {string} line
 * @param {v2Rule} rule
 */
function fullAdd(line: string, rule: v2Rule) {
  if (line.includes('*')) {
    const lineMatch = line.match(/\*.*?\.(.+)/)
    if (lineMatch === null) return console.log('unknow', line)
    if (!rule[v2Type.domain].has(lineMatch[1])) {
      // 目前v2ray并不支持这种表达式
      // line = '(?<!\\.)' + line.replace(/\./g, '\\.').replace(/\*/g, '[^\\.]+') + '$'
      line = line.replace(/\./g, '\\.').replace(/\*/g, '[^\\.]+') + '$'
      rule[v2Type.regexp].add(line)
    }
  }
  else if (!rule[v2Type.domain].has(line)) rule[v2Type.full].add(line)
}
/**
 * 添加plain规则
 *
 * @param {string} line
 * @param {v2Rule} rule
 */
function plainAdd(line: string, rule: v2Rule) {
  if (line.includes('*')) {
    const lineMatch = line.match(/\*.*?\.(.+)/)
    if (lineMatch === null) return console.log('unknow', line)
    if (!rule[v2Type.domain].has(lineMatch[1])) {
      // 目前v2ray并不支持这种表达式
      // line = '(?<!\\.)' + line.replace(/\./g, '\\.').replace(/\*/g, '[^\\.]+') + '$'
      line = line.replace(/\./g, '\\.').replace(/\*/g, '[^\\.]+') + '$'
      rule[v2Type.regexp].add(line)
    }
  }
  else {
    if (line.startsWith('.')) line = line.substr(1)
    if (rule[v2Type.full].has(line)) rule[v2Type.full].delete(line)
    rule[v2Type.domain].add(line)
  }
}
/**
 * 格式化域名, json
 *
 * @param {v2Rule} rule
 * @returns {string[]}
 */
function parseDomain2json(rule: v2Rule): string[] {
  const domainList: string[] = []
  rule[v2Type.domain].forEach(domain => domainList.push('domain:' + domain))
  rule[v2Type.full].forEach(domain => domainList.push('full:' + domain))
  rule[v2Type.regexp].forEach(domain => domainList.push('regexp:' + domain))
  return domainList
}
/**
 * 格式化域名, pb
 *
 * @param {string} rule
 * @returns {v2RulePB[]}
 */
function parseDomain2pb(rule: v2Rule): v2RulePB[] {
  const domainList: v2RulePB[] = []
  rule[v2Type.domain].forEach(domain => domainList.push({ type: v2Type.domain, value: domain }))
  rule[v2Type.full].forEach(domain => domainList.push({ type: v2Type.full, value: domain }))
  rule[v2Type.regexp].forEach(domain => domainList.push({ type: v2Type.regexp, value: domain }))
  return domainList
}
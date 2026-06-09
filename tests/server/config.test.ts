import { describe, expect, it } from 'vitest'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { getCorsOrigins, getDeployDir, getHermesHome, getListenHost, getUploadDir, getWebUiHome, shouldCreateWebUiDataDir } from '../../packages/server/src/config'

describe('server config', () => {
  it('defaults to an IPv4 bind host', () => {
    expect(getListenHost({})).toBe('0.0.0.0')
  })

  it('uses BIND_HOST when provided', () => {
    expect(getListenHost({ BIND_HOST: ' :: ' })).toBe('::')
  })

  it('ignores blank BIND_HOST values', () => {
    expect(getListenHost({ BIND_HOST: ' ' })).toBe('0.0.0.0')
  })

  it('defaults web-ui home to ~/.hermes-web-ui', () => {
    expect(getWebUiHome({})).toBe(join(homedir(), '.hermes-web-ui'))
  })

  it('uses HERMES_WEB_UI_HOME when provided', () => {
    expect(getWebUiHome({ HERMES_WEB_UI_HOME: ' ./tmp/hermes-ui ' })).toBe(resolve('./tmp/hermes-ui'))
  })

  it('uses HERMES_WEBUI_STATE_DIR as a compatibility alias', () => {
    expect(getWebUiHome({ HERMES_WEBUI_STATE_DIR: ' ./tmp/hermes-state ' })).toBe(resolve('./tmp/hermes-state'))
  })

  it('defaults upload dir under the web-ui home', () => {
    expect(getUploadDir({})).toBe(join(homedir(), '.hermes-web-ui', 'upload'))
  })

  it('uses UPLOAD_DIR when provided', () => {
    expect(getUploadDir({ UPLOAD_DIR: ' ./tmp/uploads ' })).toBe(resolve('./tmp/uploads'))
  })

  it('prefers HERMES_HOME and falls back to HERMES_HOME_DIR', () => {
    expect(getHermesHome({ HERMES_HOME: ' ./tmp/hermes-home ' })).toBe(resolve('./tmp/hermes-home'))
    expect(getHermesHome({ HERMES_HOME_DIR: ' ./tmp/hermes-home-dir ' })).toBe(resolve('./tmp/hermes-home-dir'))
  })

  it('uses DEPLOY_DIR when provided and falls back to cwd', () => {
    expect(getDeployDir({ DEPLOY_DIR: ' ./tmp/deploy ' }, 'g:/ignored')).toBe(resolve('./tmp/deploy'))
    expect(getDeployDir({}, '/tmp/current')).toBe(resolve('/tmp/current'))
  })

  it('only creates the development data directory outside production', () => {
    expect(shouldCreateWebUiDataDir({ NODE_ENV: 'development' })).toBe(true)
    expect(shouldCreateWebUiDataDir({ NODE_ENV: 'production' })).toBe(false)
  })

  it('does not enable cross-origin requests by default', () => {
    expect(getCorsOrigins({})).toBe('')
  })

  it('uses CORS_ORIGINS when provided', () => {
    expect(getCorsOrigins({ CORS_ORIGINS: ' https://app.example, http://localhost:3000 ' })).toBe('https://app.example, http://localhost:3000')
  })
})

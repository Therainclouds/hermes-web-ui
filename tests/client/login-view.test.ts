// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const mockReplace = vi.hoisted(() => vi.fn())
const mockFetchAuthStatus = vi.hoisted(() => vi.fn())
const mockLoginWithPassword = vi.hoisted(() => vi.fn())
const mockSetApiKey = vi.hoisted(() => vi.fn())
const mockClearApiKey = vi.hoisted(() => vi.fn())
const mockHasApiKey = vi.hoisted(() => vi.fn())
const mockClearLoginLocks = vi.hoisted(() => vi.fn())
const mockResetDefaultLogin = vi.hoisted(() => vi.fn())
const mockActivateUserTheme = vi.hoisted(() => vi.fn())

vi.mock('vue-router', () => ({
  useRouter: () => ({
    replace: mockReplace,
  }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/api/client', () => ({
  setApiKey: mockSetApiKey,
  clearApiKey: mockClearApiKey,
  hasApiKey: mockHasApiKey,
}))

vi.mock('@/api/auth', () => ({
  fetchAuthStatus: mockFetchAuthStatus,
  loginWithPassword: mockLoginWithPassword,
}))

vi.mock('@/api/recovery', () => ({
  clearLoginLocks: mockClearLoginLocks,
  resetDefaultLogin: mockResetDefaultLogin,
}))

vi.mock('@/composables/useTheme', () => ({
  useTheme: () => ({
    activateUserTheme: mockActivateUserTheme,
  }),
}))

import LoginView from '@/views/LoginView.vue'

describe('LoginView password login', () => {
  beforeEach(() => {
    delete (window as any).__LOGIN_TOKEN__
    vi.clearAllMocks()
    mockHasApiKey.mockReturnValue(false)
    mockFetchAuthStatus.mockResolvedValue({ hasPasswordLogin: true, username: 'quanthermes' })
    // Clean up any modals portaled to document.body from previous tests.
    document.body.innerHTML = ''
  })

  it('keeps the web login redirect when a token already exists', () => {
    mockHasApiKey.mockReturnValue(true)

    mount(LoginView)

    expect(mockClearApiKey).not.toHaveBeenCalled()
    expect(mockReplace).toHaveBeenCalledWith('/hermes/chat')
  })

  it('logs in with username and password', async () => {
    const theme = {
      fontSize: 16,
      textColor: '#202020',
      accentColor: '#3366ff',
      background: null,
      updatedAt: 42,
    }
    mockLoginWithPassword.mockResolvedValue({ token: 'jwt-token', userId: 7, theme })
    const wrapper = mount(LoginView)

    const inputs = wrapper.findAll('input.login-input')
    await inputs[0].setValue('quanthermes')
    await inputs[1].setValue('12345678')
    await wrapper.find('form.login-form').trigger('submit')

    expect(mockLoginWithPassword).toHaveBeenCalledWith('quanthermes', '12345678')
    expect(mockSetApiKey).toHaveBeenCalledWith('jwt-token')
    expect(mockActivateUserTheme).toHaveBeenCalledWith(7, theme)
    expect(mockReplace).toHaveBeenCalledWith('/hermes/chat')
  })

  it('shows the default login hint', () => {
    const wrapper = mount(LoginView)

    expect(wrapper.text()).toContain('login.defaultCredentialsHint')
  })

  it('shows an error when password login fails', async () => {
    mockLoginWithPassword.mockRejectedValue(new Error('Invalid username or password'))
    const wrapper = mount(LoginView)

    const inputs = wrapper.findAll('input.login-input')
    await inputs[0].setValue('quanthermes')
    await inputs[1].setValue('bad-password')
    await wrapper.find('form.login-form').trigger('submit')

    expect(wrapper.find('.login-error').text()).toBe('Invalid username or password')
    expect(mockSetApiKey).not.toHaveBeenCalled()
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it('shows the lock hint with two recovery buttons when the login IP is locked', async () => {
    const err: any = new Error('Too many login attempts')
    err.status = 429
    mockLoginWithPassword.mockRejectedValue(err)
    const wrapper = mount(LoginView)

    const inputs = wrapper.findAll('input.login-input')
    await inputs[0].setValue('quanthermes')
    await inputs[1].setValue('12345678')
    await wrapper.find('form.login-form').trigger('submit')
    await flushPromises()

    expect(wrapper.find('.login-error').text()).toBe('login.tooManyAttempts')
    const hint = wrapper.find('.login-lock-hint')
    expect(hint.text()).toContain('login.lockResetHint')
    expect(hint.text()).toContain('login.defaultLoginResetHint')
    const buttons = wrapper.findAll('.login-lock-hint__btn')
    expect(buttons).toHaveLength(2)
    expect(buttons[0].text()).toBe('login.recoveryClearLocksButton')
    expect(buttons[1].text()).toBe('login.recoveryResetPasswordButton')
  })

  it('opens the clear-locks recovery modal and calls the API on submit', async () => {
    const err: any = new Error('Too many login attempts')
    err.status = 503
    mockLoginWithPassword.mockRejectedValue(err)
    mockClearLoginLocks.mockResolvedValue({ success: true, action: 'cleared-locks', clearedCount: 2 })

    const wrapper = mount(LoginView)
    const inputs = wrapper.findAll('input.login-input')
    await inputs[0].setValue('quanthermes')
    await inputs[1].setValue('12345678')
    await wrapper.find('form.login-form').trigger('submit')
    await flushPromises()

    await wrapper.findAll('.login-lock-hint__btn')[0].trigger('click')
    await flushPromises()

    // NModal portals its body to document.body, so query globally.
    const passwordInput = document.querySelector('.recovery-modal input[type="password"]') as HTMLInputElement
    expect(passwordInput).toBeTruthy()
    passwordInput.value = '12345678'
    passwordInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    const confirmBtn = document.querySelector('.recovery-modal__footer button.n-button--primary-type') as HTMLButtonElement
    expect(confirmBtn).toBeTruthy()
    confirmBtn.click()
    await flushPromises()

    expect(mockClearLoginLocks).toHaveBeenCalledWith('12345678')
    expect(mockResetDefaultLogin).not.toHaveBeenCalled()
  })

  it('shows an error when the recovery API rejects', async () => {
    const err: any = new Error('Too many login attempts')
    err.status = 429
    mockLoginWithPassword.mockRejectedValue(err)
    mockClearLoginLocks.mockRejectedValue(new Error('Invalid recovery password'))

    const wrapper = mount(LoginView)
    const inputs = wrapper.findAll('input.login-input')
    await inputs[0].setValue('quanthermes')
    await inputs[1].setValue('12345678')
    await wrapper.find('form.login-form').trigger('submit')
    await flushPromises()

    await wrapper.findAll('.login-lock-hint__btn')[0].trigger('click')
    await flushPromises()

    const passwordInput = document.querySelector('.recovery-modal input[type="password"]') as HTMLInputElement
    passwordInput.value = 'wrong'
    passwordInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    const confirmBtn = document.querySelector('.recovery-modal__footer button.n-button--primary-type') as HTMLButtonElement
    confirmBtn.click()
    await flushPromises()

    expect(mockClearLoginLocks).toHaveBeenCalledWith('wrong')
    const errorEl = document.querySelector('.recovery-modal__error')
    expect(errorEl?.textContent).toBe('Invalid recovery password')
  })

  it('uses the reset-password API when the second button is clicked', async () => {
    const err: any = new Error('Too many login attempts')
    err.status = 429
    mockLoginWithPassword.mockRejectedValue(err)
    mockResetDefaultLogin.mockResolvedValue({ success: true, action: 'reset-password', username: 'quanthermes' })

    const wrapper = mount(LoginView)
    const inputs = wrapper.findAll('input.login-input')
    await inputs[0].setValue('quanthermes')
    await inputs[1].setValue('12345678')
    await wrapper.find('form.login-form').trigger('submit')
    await flushPromises()

    await wrapper.findAll('.login-lock-hint__btn')[1].trigger('click')
    await flushPromises()

    const passwordInput = document.querySelector('.recovery-modal input[type="password"]') as HTMLInputElement
    passwordInput.value = '12345678'
    passwordInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    const confirmBtn = document.querySelector('.recovery-modal__footer button.n-button--primary-type') as HTMLButtonElement
    confirmBtn.click()
    await flushPromises()

    expect(mockResetDefaultLogin).toHaveBeenCalledWith('12345678')
  })
})

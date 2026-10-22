import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  helper: false,
  requestSingleInstanceLock: vi.fn(),
  exit: vi.fn()
}))

vi.mock('electron', () => ({
  app: { requestSingleInstanceLock: state.requestSingleInstanceLock, exit: state.exit }
}))
vi.mock('../../src/main/app-data-bootstrap', () => ({
  get isLegacyMigrationHelper() { return state.helper }
}))

describe('single instance startup', () => {
  beforeEach(() => {
    vi.resetModules()
    state.helper = false
    state.requestSingleInstanceLock.mockReset().mockReturnValue(true)
    state.exit.mockReset()
  })

  it('allows the primary instance to initialize', async () => {
    await import('../../src/main/single-instance-bootstrap')
    expect(state.requestSingleInstanceLock).toHaveBeenCalledOnce()
    expect(state.exit).not.toHaveBeenCalled()
  })

  it('exits a duplicate before services and caches initialize', async () => {
    state.requestSingleInstanceLock.mockReturnValue(false)
    await import('../../src/main/single-instance-bootstrap')
    expect(state.exit).toHaveBeenCalledWith(0)
  })

  it('keeps the legacy migration helper independent from the GUI instance', async () => {
    state.helper = true
    await import('../../src/main/single-instance-bootstrap')
    expect(state.requestSingleInstanceLock).not.toHaveBeenCalled()
    expect(state.exit).not.toHaveBeenCalled()
  })
})

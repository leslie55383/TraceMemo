import { app } from 'electron'
import { isLegacyMigrationHelper } from './app-data-bootstrap'

// userData is selected by app-data-bootstrap before acquiring the lock.
// Exit before service imports or Chromium initialization can open the same files.
if (!isLegacyMigrationHelper && !app.requestSingleInstanceLock()) {
  app.exit(0)
}

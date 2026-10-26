import { mkdtemp, mkdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  AttachmentDocumentService,
  runAttachmentProcess
} from '../../src/main/attachments/attachment-document-service'

// Explicitly opt in: never installs packages or reads a user's real attachment/profile.
describe.skipIf(!process.env.TM_DOCLING_PYTHON)(
  'actual Docling child process and local store',
  () => {
    it('parses a synthetic document, searches/reads it under the original source, and clears the derived index only', async () => {
      const root = await mkdtemp(join(tmpdir(), 'tracememo-attachment-test-'))
      const previous = process.env.WXE_DOCLING_PYTHON
      const python = process.env.TM_DOCLING_PYTHON!
      process.env.WXE_DOCLING_PYTHON = python
      let account = 'synthetic-account-a'
      const file = join(root, '预算.docx')
      const source = {
        conversationId: 'synthetic-group',
        messageId: 'local:7',
        createTime: 100,
        fileName: '预算.docx',
        sender: '测试成员'
      }
      const service = new AttachmentDocumentService({
        root,
        accountId: () => account,
        resolveSource: async () => source,
        chooseFile: async () => file
      })
      try {
        await mkdir(join(root, 'docling', 'models'), { recursive: true })
        await runAttachmentProcess(python, [
          '-c',
          `import sys;from docx import Document;d=Document();d.add_paragraph('本地附件预算24680元');d.save(sys.argv[1])`,
          file
        ])
        expect((await service.parse(source)).state).toBe('indexed')
        expect(
          (
            await service.search({
              text: '预算',
              terms: ['预算'],
              conversationIds: [source.conversationId],
              startTime: 100,
              endTime: 100
            })
          ).evidence[0]
        ).toMatchObject({ derivedSource: 'attachment_text', messageId: 'local:7' })
        const read = await service.read(source.conversationId, ['local:7'])
        expect(read.documents[0].parts.map((p) => p.text).join('')).toContain('24680')
        const excerptRequest = { conversationId: source.conversationId, references: [{ messageId: source.messageId, createTime: 100 }] }
        const excerpts = await service.readExcerpts(excerptRequest)
        expect(excerpts.documents[0].parts.map(p => p.text).join('')).toContain('24680')
        expect(excerpts.documents[0].coverage.truncated).toBe(false)
        expect((await service.readExcerpts({ ...excerptRequest, references: [{ messageId: source.messageId, createTime: 101 }] })).documents).toEqual([])
        account = 'synthetic-account-b'
        expect((await service.readExcerpts(excerptRequest)).documents).toEqual([])
        expect((await service.search({ text: '预算', terms: ['预算'] })).evidence).toEqual([])
        account = 'synthetic-account-a'
        expect((await service.remove(source)).state).toBe('unparsed')
        expect((await service.search({ text: '预算', terms: ['预算'] })).evidence).toEqual([])
        await service.clearIndexes()
      } finally {
        service.dispose()
        if (previous === undefined) delete process.env.WXE_DOCLING_PYTHON
        else process.env.WXE_DOCLING_PYTHON = previous
        await rm(root, { recursive: true, force: true })
      }
    }, 120_000)
  }
)

import { it, expect } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { extractPdfSource } from '../../packages/server/src/services/trpg/pdf-source'
it('extracts flattened PDF text with page coordinates for ordinary text models', async () => {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  pdf.addPage().drawText('Sylvan Monk 1 STR 12 DEX 16', { x: 40, y: 600, font, size: 12 })
  pdf.addPage().drawText('Backstory: a wandering monk', { x: 40, y: 600, font, size: 12 })
  const text = await extractPdfSource(await pdf.save())
  expect(text).toContain('Page 1')
  expect(text).toContain('Page 2')
  expect(text).toContain('[40,600] Sylvan Monk 1 STR 12 DEX 16')
  expect(text).toContain('Backstory: a wandering monk')
})

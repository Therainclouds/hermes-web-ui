import { describe, expect, it } from 'vitest'
import { isMcuFillerTranscript } from '../../packages/server/src/controllers/hermes/stt'

describe('MCU back-channel filter', () => {
  it('drops filler noises that used to trigger a full agent turn', () => {
    for (const filler of ['嗯', '嗯。', ' 哦 ', '啊？', '呃…', '嗯嗯', '在吗', '那个']) {
      expect(isMcuFillerTranscript(filler), filler).toBe(true)
    }
  })

  it('keeps real questions and commands', () => {
    for (const real of ['帮我查一下官渡区的门店', '嗯帮我查一下门店', '在吗？帮我开个灯', '你好小智', '停', '']) {
      expect(isMcuFillerTranscript(real), real).toBe(real === '')
    }
  })
})

import { describe, expect, it } from 'vitest'
import {
  createMcuSpeechSegmenter,
  normalizeMcuSpeechText,
} from '../../packages/server/src/services/global-agent/mcu-speech-segmenter'

describe('MCU speech segmenter', () => {
  it('waits for markdown links to close before emitting speech', () => {
    const segmenter = createMcuSpeechSegmenter({ maxChars: 24 })

    expect(segmenter.pushDelta('请打开 [控制台')).toEqual([])
    expect(segmenter.pushDelta('](https://example.com)。\n')).toEqual([
      '请打开 控制台。',
    ])
  })

  it('skips fenced code and table rows when flushing readable text', () => {
    const segmenter = createMcuSpeechSegmenter({ maxChars: 24 })

    const segments = [
      ...segmenter.pushDelta('结果如下：\n```ts\nconst value = 1;\n```\n'),
      ...segmenter.pushDelta('| 名称 | 值 |\n| --- | --- |\n| foo | 1 |\n请确认。'),
    ]
    const flushed = segmenter.flush()
    expect(segments).toEqual([])
    expect(flushed).toContain('结果如下')
    expect(flushed).toContain('请确认')
    expect(flushed).not.toContain('const value')
    expect(flushed).not.toContain('foo')
  })

  it('emits completed paragraphs and carries unfinished paragraphs into the next one', () => {
    const segmenter = createMcuSpeechSegmenter({ maxChars: 24 })

    expect(segmenter.pushDelta('第一段还没结束\n')).toEqual([])
    expect(segmenter.pushDelta('第二段结束了。\n')).toEqual([
      '第一段还没结束 第二段结束了。',
    ])
    expect(segmenter.pushDelta('第三段好了！\n')).toEqual([
      '第三段好了！',
    ])
  })

  it('chunks a run-on sentence at a clause break once maxChars is exceeded', () => {
    // maxChars used to be a dead option: long text waited for its final full
    // stop (and was then silently hard-truncated at 1500 chars by the TTS
    // clamp). It now splits at a real clause break so speech can start early.
    const segmenter = createMcuSpeechSegmenter({ maxChars: 24 })
    const longText = '这是一段很长很长的内容，没有提前结束，也不会因为逗号，或者长度超过限制就提前播放'

    const first = segmenter.pushDelta(longText)
    // The first chunk must be a clause, not the whole run-on sentence.
    expect(first.length).toBeGreaterThan(0)
    expect(first[0]!.length).toBeLessThanOrEqual(24)
    expect(first[0]!.endsWith('，')).toBe(true)

    const rest = segmenter.pushDelta('直到段落正常结束。\n')
    // Nothing is lost or duplicated: the chunks reassemble the source.
    const joined = [...first, ...rest].join('')
    expect(joined.replace(/\s+/g, '')).toBe(
      `${longText}直到段落正常结束。`.replace(/\s+/g, ''),
    )
  })

  it('normalizes markdown without preserving table syntax', () => {
    const normalized = normalizeMcuSpeechText('结果如下：\n| 名称 | 值 |\n| --- | --- |\n| foo | 1 |\n[详情](https://example.com)。参考 https://example.com/a?b=1 和 www.example.com/path')
    expect(normalized).toContain('结果如下')
    expect(normalized).toContain('详情')
    expect(normalized).not.toContain('https')
    expect(normalized).not.toContain('www.')
    expect(normalized).not.toContain('foo')
  })
})

it('can stream a complete short Chinese sentence before the paragraph finishes', () => {
  const segmenter = createMcuSpeechSegmenter({ sentenceStreaming: true })
  expect(segmenter.pushDelta('可以，我先帮你查一下。后面')).toEqual(['可以，我先帮你查一下。'])
  expect(segmenter.flush()).toBe('后面')
})

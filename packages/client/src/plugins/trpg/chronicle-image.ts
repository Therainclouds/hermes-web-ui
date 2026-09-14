import type { RecapEntry, RecapImageKind } from '../../../../shared/trpg-recap'
import type { CharacterCard } from './storage'
import type { ImageReference } from './imageRequest'

/**
 * Pure prompt/cast helpers for chronicle illustrations.
 *
 * The reader page displays these images beside the book, so one "cover" slot
 * illustrates the whole chronicle and each "content" slot illustrates one
 * chapter. Keeping the prompt assembly framework-free lets the wording be
 * unit-tested without mounting the panel or calling an image backend.
 */
export interface ChronicleCastMember { id: string; name: string; appearance: string; image?: Blob }

/** Characters that appear in the selected chapter (or the whole chronicle for a cover). */
export function chronicleCast(entry: RecapEntry, kind: RecapImageKind, chapterId: string | undefined, characters: CharacterCard[]): ChronicleCastMember[] {
  const chapters = kind === 'content' && chapterId ? entry.chapters.filter(chapter => chapter.id === chapterId) : entry.chapters
  const ids = new Set<string>()
  for (const chapter of chapters) for (const highlight of chapter.highlights || []) if (highlight.characterId) ids.add(highlight.characterId)
  const byId = new Map(characters.map(card => [card.id, card]))
  // A chapter with no recorded highlights still deserves a picture: fall back to
  // every named card so the cover/content has someone to show.
  const pool = ids.size ? [...ids].map(id => byId.get(id)).filter((card): card is CharacterCard => !!card) : characters
  const seen = new Set<string>()
  const cast: ChronicleCastMember[] = []
  for (const card of pool) {
    const name = card.name.replace(/[【】\r\n]/g, '').trim()
    if (!name || seen.has(card.id)) continue
    seen.add(card.id)
    cast.push({ id: card.id, name, appearance: (card.appearance || '').trim(), image: card.image })
  }
  return cast
}

/** Portraits attached to the request, in cast order, capped at what backends accept. */
export function chronicleReferences(cast: ChronicleCastMember[]): ImageReference[] {
  return cast.filter(member => member.image).slice(0, 4).map(member => ({ name: member.name, blob: member.image as Blob }))
}

/** Assemble the image prompt for one chronicle slot. */
export function buildChronicleImagePrompt(entry: RecapEntry, kind: RecapImageKind, chapterId: string | undefined, cast: ChronicleCastMember[], style = ''): string {
  const visualStyle = (style || entry.style || '暗黑奇幻、油画质感、电影光影').trim()
  const castBlock = cast.slice(0, 8).map(member => member.appearance ? `- 【${member.name}】（外观：${member.appearance}）` : `- 【${member.name}】`).join('\n')
  const shared = [
    `整体风格：${visualStyle}。`,
    entry.setting ? `世界设定：${entry.setting}` : '',
    castBlock ? `出场角色（标记仅用于指代，不作为画面文字）：\n${castBlock}` : '',
    '单幅插画，构图完整，光影统一，保持角色外观一致；不要在画面上渲染任何文字、标题、字幕或水印。',
  ].filter(Boolean)
  if (kind === 'cover') {
    return [
      `为跑团编年史《${entry.title}》绘制书籍封面插画，画面要有冒险的史诗感，并为题签留出呼吸空间。`,
      ...shared,
    ].join('\n\n')
  }
  const chapter = entry.chapters.find(item => item.id === chapterId)
  const illustration = chapter ? `章节《${chapter.title}》` : '整部编年史'
  const body = chapter?.body ? `章节内容参考：${chapter.body.slice(0, 1200)}` : ''
  return [
    `为跑团编年史《${entry.title}》的${illustration}绘制情节插画，捕捉这一段落最有戏剧张力的瞬间。`,
    body,
    ...shared,
  ].filter(Boolean).join('\n\n')
}

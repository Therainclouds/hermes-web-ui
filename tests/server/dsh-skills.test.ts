import { describe, expect, it } from 'vitest'
import { validateDshSkill } from '../../packages/server/src/services/coding-agents/dsh/skills'

describe('DSH skill frontmatter validation', () => {
  it('accepts kebab-case names with description', () => {
    const content = `---
name: my-skill
description: Helpful skill
---
# Body
`
    expect(validateDshSkill(content)).toEqual({ name: 'my-skill', description: 'Helpful skill' })
  })

  it('rejects non-kebab-case names', () => {
    const content = `---
name: MySkill
description: helpful
---
`
    expect(() => validateDshSkill(content)).toThrow(/kebab-case/)
  })

  it('rejects missing description', () => {
    const content = `---
name: my-skill
---
`
    expect(() => validateDshSkill(content)).toThrow(/description/)
  })

  it('rejects malformed YAML frontmatter', () => {
    const content = `---
name: [broken
---
`
    expect(() => validateDshSkill(content)).toThrow(/kebab-case/)
  })
})
import { defineComponent, h, type PropType } from 'vue'
import type { BookPage } from './recapBook'

/**
 * One rendered paper face. Shared by the static pages and the flipping leaf so
 * both sides of a turn show byte-identical markup, and kept in its own module
 * (rather than a second `<script>` block) so `<script setup>` resolution stays
 * unambiguous.
 */
export const BookFace = defineComponent({
  name: 'BookFace',
  props: {
    page: { type: Object as PropType<BookPage>, required: true },
    title: { type: String, required: true },
    modeLabel: { type: String, default: '' },
    toneLabel: { type: String, default: '' },
    dateText: { type: String, default: '' },
  },
  setup(props) {
    return () => {
      if (props.page.variant === 'cover') {
        return h('div', { class: 'book-cover' }, [
          h('div', { class: 'cover-frame' }, [
            h('span', { class: 'cover-rule' }),
            h('p', { class: 'cover-kicker' }, '卷'),
            h('h1', { class: 'cover-title' }, props.title),
            h('p', { class: 'cover-meta' }, [props.modeLabel, props.toneLabel, props.dateText].filter(Boolean).join(' · ')),
            h('span', { class: 'cover-seal' }, '記'),
            h('span', { class: 'cover-rule' }),
          ]),
        ])
      }
      if (props.page.variant === 'blank') return h('div', { class: 'page-blank' })
      return h('div', { class: 'page-content', innerHTML: props.page.html || '' })
    }
  },
})

export default BookFace

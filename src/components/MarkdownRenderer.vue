<script setup lang="ts">
import { computed } from 'vue'
import { parseMarkdown, sanitizeMarkdownUrl } from '@/utils/markdown'

const props = defineProps<{
  content: string
}>()

const tokens = computed(() => parseMarkdown(props.content))
</script>

<template>
  <span class="markdown-content">
    <template v-for="(token, index) in tokens" :key="index">
      <img
        v-if="token.type === 'image'"
        :src="sanitizeMarkdownUrl(token.url, 'image')"
        :alt="token.alt"
        loading="lazy"
        class="align-middle h-auto max-w-full inline-block rounded"
        style="max-height: 200px;"
      >
      <a
        v-else-if="token.type === 'link'"
        :href="sanitizeMarkdownUrl(token.url, 'link')"
        target="_blank"
        rel="noopener noreferrer"
        class="text-primary underline-offset-4 hover:underline"
      >
        {{ token.content }}
      </a>
      <strong v-else-if="token.type === 'bold'">{{ token.content }}</strong>
      <em v-else-if="token.type === 'italic'">{{ token.content }}</em>
      <code
        v-else-if="token.type === 'code'"
        class="px-1.5 py-0.5 rounded bg-muted text-foreground text-[0.85em] font-mono"
      >{{ token.content }}</code>
      <br v-else-if="token.type === 'br'">
      <span v-else-if="token.type === 'text'">{{ token.content }}</span>
    </template>
  </span>
</template>

<style scoped>
.markdown-content {
  line-height: 1.6;
}
</style>

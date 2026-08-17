import antfu from '@antfu/eslint-config'

export default antfu({
  formatters: true,
  vue: true,
  ignores: [
    'src/utils/iconify.icons.ts',
  ],
})

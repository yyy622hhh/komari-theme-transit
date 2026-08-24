<script setup lang="ts">
import { Icon } from '@iconify/vue'
import { computed } from 'vue'
import { TOPOLOGY_PROBE_OPTIONS } from '@/utils/topologyPresets'

const props = withDefaults(defineProps<{ modelValue: string, customLabel?: string, disabled?: boolean, resettable?: boolean }>(), {
  customLabel: '',
  disabled: false,
  resettable: false,
})
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const selected = computed(() => TOPOLOGY_PROBE_OPTIONS.find(option => option.key === props.modelValue))
const label = computed(() => selected.value?.label || props.customLabel || '自定义入口')
const cities = ['北京', '上海', '广州']

function updateValue(event: Event) {
  const target = event.target
  if (target instanceof HTMLSelectElement)
    emit('update:modelValue', target.value)
}
</script>

<template>
  <label class="group relative flex min-w-0 flex-1 items-center gap-1.5">
    <span class="sr-only">切换入口探测点</span>
    <img
      v-if="selected"
      src="/images/flags/CN.svg"
      alt="CN"
      class="h-3.5 w-5 shrink-0 rounded-[2px] object-cover"
    >
    <span v-if="disabled" class="min-w-0 flex-1 truncate px-1 text-xs font-semibold text-slate-800 dark:text-slate-200 sm:text-[13px]" :title="label">
      {{ label }}
    </span>
    <select
      v-else
      :value="selected?.key || ''"
      :title="label"
      class="h-7 min-w-0 flex-1 cursor-pointer appearance-none rounded-md border border-transparent bg-transparent py-0 pl-0 pr-5 text-xs font-semibold text-slate-800 outline-none transition hover:border-slate-500/20 hover:bg-slate-900/[0.025] focus:border-emerald-500/30 focus:ring-2 focus:ring-emerald-500/10 dark:text-slate-200 dark:hover:border-white/[0.07] dark:hover:bg-white/[0.025] dark:focus:border-emerald-400/25 dark:focus:ring-emerald-400/10 sm:text-[13px]"
      :aria-label="`当前入口 ${label}，点击切换`"
      @change="updateValue"
    >
      <option v-if="!selected || resettable" value="">
        {{ customLabel || label }}{{ resettable ? '（恢复原始配置）' : '' }}
      </option>
      <optgroup v-for="city in cities" :key="city" :label="city">
        <option
          v-for="option in TOPOLOGY_PROBE_OPTIONS.filter(item => item.city === city)"
          :key="option.key"
          :value="option.key"
        >
          {{ option.label }}
        </option>
      </optgroup>
    </select>
    <Icon
      v-if="!disabled"
      icon="tabler:chevron-down"
      :width="13"
      class="pointer-events-none absolute right-1 text-slate-500 transition group-focus-within:text-emerald-400"
    />
  </label>
</template>

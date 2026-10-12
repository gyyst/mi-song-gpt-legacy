<script setup lang="ts">
import { computed, onUnmounted, ref, useAttrs, watch } from 'vue';

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    modelValue: number;
    min?: number;
    max?: number;
    step?: number;
    disabled?: boolean;
    ariaLabel?: string;
    orientation?: 'horizontal' | 'vertical';
  }>(),
  { min: 0, max: 100, step: 1, orientation: 'horizontal' },
);
const emit = defineEmits<{ 'update:modelValue': [number]; change: [number]; dragging: [boolean] }>();
const attrs = useAttrs();
const track = ref<HTMLElement | null>(null);
const shell = ref<HTMLElement | null>(null);
const input = ref<HTMLInputElement | null>(null);
const pointerId = ref<number | null>(null);
const dragValue = ref(props.modelValue);
const displayValue = computed(() => pointerId.value === null ? props.modelValue : dragValue.value);

function valueFrom(event: Event): number {
  return Number((event.target as HTMLInputElement).value);
}

function positionFromEvent(clientY: number): number {
  const el = track.value;
  if (!el) return props.modelValue;
  const rect = el.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, rect.height > 0 ? 1 - (clientY - rect.top) / rect.height : 0));
  const value = props.min + ratio * (props.max - props.min);
  const step = props.step > 0 ? props.step : 1;
  return Math.max(props.min, Math.min(props.max, props.min + Math.round((value - props.min) / step) * step));
}

function updatePointer(event: PointerEvent): void {
  dragValue.value = positionFromEvent(event.clientY);
  emit('update:modelValue', dragValue.value);
}

function onPointerDown(event: PointerEvent): void {
  if (props.orientation !== 'vertical' || props.disabled || pointerId.value !== null || event.button !== 0) return;
  event.preventDefault();
  pointerId.value = event.pointerId;
  shell.value?.setPointerCapture(event.pointerId);
  input.value?.focus({ preventScroll: true });
  emit('dragging', true);
  updatePointer(event);
}

function onPointerMove(event: PointerEvent): void {
  if (pointerId.value !== event.pointerId) return;
  updatePointer(event);
}

function releasePointer(): void {
  const id = pointerId.value;
  pointerId.value = null;
  if (id !== null && shell.value?.hasPointerCapture(id)) shell.value.releasePointerCapture(id);
  emit('dragging', false);
}

function onPointerUp(event: PointerEvent): void {
  if (pointerId.value !== event.pointerId) return;
  updatePointer(event);
  const value = dragValue.value;
  releasePointer();
  emit('change', value);
}

function cancelPointer(event?: PointerEvent): void {
  if (event && pointerId.value !== event.pointerId) return;
  if (pointerId.value === null) return;
  releasePointer();
}

watch(() => props.disabled, (disabled) => {
  if (disabled) cancelPointer();
});
onUnmounted(cancelPointer);

const fillPercent = computed(() => {
  const range = props.max - props.min;
  if (range <= 0) return 0;
  return Math.max(0, Math.min(100, ((displayValue.value - props.min) / range) * 100));
});
const thumbStyle = computed(() => ({ bottom: `calc(${fillPercent.value}% - ${fillPercent.value * .12}px)` }));
</script>

<template>
  <div
    ref="shell"
    v-bind="attrs"
    class="sl-slider-wrap"
    :class="{ 'sl-slider-vertical': orientation === 'vertical', 'sl-slider-vertical-disabled': orientation === 'vertical' && disabled }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="cancelPointer"
    @lostpointercapture="cancelPointer"
  >
    <template v-if="orientation === 'vertical'">
      <div ref="track" class="sl-slider-vertical-track" aria-hidden="true">
        <div class="sl-slider-vertical-fill" :style="{ height: fillPercent + '%' }"></div>
      </div>
      <span class="sl-slider-vertical-thumb" :style="thumbStyle" aria-hidden="true"></span>
    </template>
    <input
      ref="input"
      class="sl-slider"
      :class="{ 'sl-slider-vertical-input': orientation === 'vertical' }"
      type="range"
      :value="displayValue"
      :min="min"
      :max="max"
      :step="step"
      :disabled="disabled"
      :aria-label="ariaLabel"
      :aria-orientation="orientation"
      @input="emit('update:modelValue', valueFrom($event))"
      @change="emit('change', valueFrom($event))"
    />
  </div>
</template>

<template>
  <IconBase :size="size" :stroke-width="strokeWidth">
    <path d="M21 12a9 9 0 1 1-2.6-6.4" />
    <path d="M21 3.5V9h-5.5" />
  </IconBase>
</template>

<script setup>
import IconBase from './IconBase.vue';
defineProps({ size: { type: [Number, String], default: 18 }, strokeWidth: { type: [Number, String], default: 1.75 } });
</script>

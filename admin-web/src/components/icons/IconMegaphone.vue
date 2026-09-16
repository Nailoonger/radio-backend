<template>
  <IconBase :size="size" :stroke-width="strokeWidth">
    <path d="M4 10v3a1 1 0 0 0 1 1h2.5L11 18V5L7.5 9H5a1 1 0 0 0-1 1z" />
    <path d="M15 9.5a3.5 3.5 0 0 1 0 5" />
    <path d="M18 7a7 7 0 0 1 0 10" />
  </IconBase>
</template>

<script setup>
import IconBase from './IconBase.vue';
defineProps({ size: { type: [Number, String], default: 18 }, strokeWidth: { type: [Number, String], default: 1.75 } });
</script>

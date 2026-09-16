<template>
  <IconBase :size="size" :stroke-width="strokeWidth">
    <rect x="2.5" y="7" width="15" height="10" rx="5" />
    <circle cx="18.5" cy="12" r="3" />
  </IconBase>
</template>

<script setup>
import IconBase from './IconBase.vue';
defineProps({ size: { type: [Number, String], default: 18 }, strokeWidth: { type: [Number, String], default: 1.75 } });
</script>

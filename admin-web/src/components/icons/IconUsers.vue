<template>
  <IconBase :size="size" :stroke-width="strokeWidth">
    <path d="M16 20v-1.6a3.4 3.4 0 0 0-3.4-3.4H6.4A3.4 3.4 0 0 0 3 18.4V20" />
    <circle cx="9.5" cy="8" r="3.5" />
    <path d="M21 20v-1.6a3.4 3.4 0 0 0-2.6-3.3M15.5 4.7a3.4 3.4 0 0 1 0 6.6" />
  </IconBase>
</template>

<script setup>
import IconBase from './IconBase.vue';
defineProps({ size: { type: [Number, String], default: 18 }, strokeWidth: { type: [Number, String], default: 1.75 } });
</script>

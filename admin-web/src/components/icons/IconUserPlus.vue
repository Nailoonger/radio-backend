<template>
  <IconBase :size="size" :stroke-width="strokeWidth">
    <path d="M15 20v-1.6a3.4 3.4 0 0 0-3.4-3.4H6.4A3.4 3.4 0 0 0 3 18.4V20" />
    <circle cx="9" cy="8" r="3.5" />
    <path d="M19 8v6M16 11h6" />
  </IconBase>
</template>

<script setup>
import IconBase from './IconBase.vue';
defineProps({ size: { type: [Number, String], default: 18 }, strokeWidth: { type: [Number, String], default: 1.75 } });
</script>

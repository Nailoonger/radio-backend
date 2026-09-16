<template>
  <IconBase :size="size" :stroke-width="strokeWidth">
    <path d="M3 3v18h18" />
    <path d="M7 15l4-5 3.5 3.5L21 7" />
  </IconBase>
</template>

<script setup>
import IconBase from './IconBase.vue';
defineProps({ size: { type: [Number, String], default: 18 }, strokeWidth: { type: [Number, String], default: 1.75 } });
</script>

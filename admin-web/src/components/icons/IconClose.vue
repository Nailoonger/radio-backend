<template>
  <IconBase :size="size" :stroke-width="strokeWidth">
    <path d="M18 6L6 18M6 6l12 12" />
  </IconBase>
</template>

<script setup>
import IconBase from './IconBase.vue';
defineProps({ size: { type: [Number, String], default: 18 }, strokeWidth: { type: [Number, String], default: 1.75 } });
</script>

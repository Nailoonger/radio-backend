<template>
  <IconBase :size="size" :stroke-width="strokeWidth">
    <path d="M6 9l6 6 6-6" />
  </IconBase>
</template>

<script setup>
import IconBase from './IconBase.vue';
defineProps({ size: { type: [Number, String], default: 18 }, strokeWidth: { type: [Number, String], default: 1.75 } });
</script>

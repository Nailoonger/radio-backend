<template>
  <IconBase :size="size" :stroke-width="strokeWidth">
    <path d="M21 11.5a8 8 0 0 1-11.6 7.1L4 20.5l1.9-5.2A8 8 0 1 1 21 11.5z" />
  </IconBase>
</template>

<script setup>
import IconBase from './IconBase.vue';
defineProps({ size: { type: [Number, String], default: 18 }, strokeWidth: { type: [Number, String], default: 1.75 } });
</script>

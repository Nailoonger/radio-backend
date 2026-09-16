<template>
  <IconBase :size="size" :stroke-width="strokeWidth">
    <path d="M20 6L9 17l-5-5" />
  </IconBase>
</template>

<script setup>
import IconBase from './IconBase.vue';
defineProps({ size: { type: [Number, String], default: 18 }, strokeWidth: { type: [Number, String], default: 1.75 } });
</script>

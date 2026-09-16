<template>
  <IconBase :size="size" :stroke-width="strokeWidth">
    <path d="M12 19V5M5 12l7-7 7 7" />
  </IconBase>
</template>

<script setup>
import IconBase from './IconBase.vue';
defineProps({ size: { type: [Number, String], default: 18 }, strokeWidth: { type: [Number, String], default: 1.75 } });
</script>

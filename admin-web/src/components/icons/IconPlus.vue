<template>
  <IconBase :size="size" :stroke-width="strokeWidth">
    <path d="M12 5v14M5 12h14" />
  </IconBase>
</template>

<script setup>
import IconBase from './IconBase.vue';
defineProps({ size: { type: [Number, String], default: 18 }, strokeWidth: { type: [Number, String], default: 1.75 } });
</script>

<template>
  <IconBase :size="size" :stroke-width="strokeWidth">
    <path d="M7.5 21h9M12 17.5V21" />
    <path d="M6 4h12v5a6 6 0 0 1-12 0z" />
    <path d="M6 5.5H3.5V7a3 3 0 0 0 2.9 3M18 5.5h2.5V7a3 3 0 0 1-2.9 3" />
  </IconBase>
</template>

<script setup>
import IconBase from './IconBase.vue';
defineProps({ size: { type: [Number, String], default: 18 }, strokeWidth: { type: [Number, String], default: 1.75 } });
</script>

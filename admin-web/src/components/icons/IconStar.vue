<template>
  <IconBase :size="size" :stroke-width="strokeWidth">
    <path d="M12 3l2.4 1.3 2.7-.3 1 2.5 2.2 1.6-.7 2.6.7 2.6-2.2 1.6-1 2.5-2.7-.3L12 21l-2.4-1.3-2.7.3-1-2.5L3.7 15.9l.7-2.6-.7-2.6 2.2-1.6 1-2.5 2.7.3z" />
    <circle cx="12" cy="12" r="2.6" />
  </IconBase>
</template>

<script setup>
import IconBase from './IconBase.vue';
defineProps({ size: { type: [Number, String], default: 18 }, strokeWidth: { type: [Number, String], default: 1.75 } });
</script>

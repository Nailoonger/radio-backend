<template>
  <IconBase :size="size" :stroke-width="strokeWidth">
    <circle cx="7.5" cy="15.5" r="4.5" />
    <path d="M10.7 12.3 21 2" />
    <path d="M18 5l3 3" />
    <path d="M15 8l2.5 2.5" />
  </IconBase>
</template>

<script setup>
import IconBase from './IconBase.vue';
defineProps({ size: { type: [Number, String], default: 18 }, strokeWidth: { type: [Number, String], default: 1.75 } });
</script>

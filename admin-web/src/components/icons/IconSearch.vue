<template>
  <IconBase :size="size" :stroke-width="strokeWidth">
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </IconBase>
</template>

<script setup>
import IconBase from './IconBase.vue';
defineProps({ size: { type: [Number, String], default: 18 }, strokeWidth: { type: [Number, String], default: 1.75 } });
</script>

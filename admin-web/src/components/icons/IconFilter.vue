<template>
  <IconBase :size="size" :stroke-width="strokeWidth">
    <path d="M3 5h18l-7 8v6l-4 2v-8z" />
  </IconBase>
</template>

<script setup>
import IconBase from './IconBase.vue';
defineProps({ size: { type: [Number, String], default: 18 }, strokeWidth: { type: [Number, String], default: 1.75 } });
</script>

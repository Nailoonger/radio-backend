<template>
  <IconBase :size="size" :stroke-width="strokeWidth">
    <path d="M12 3l1.9 5.3 5.6.3-4.4 3.5 1.5 5.4L12 14.4 7.4 17.5l1.5-5.4L4.5 8.6l5.6-.3z" />
  </IconBase>
</template>

<script setup>
import IconBase from './IconBase.vue';
defineProps({ size: { type: [Number, String], default: 18 }, strokeWidth: { type: [Number, String], default: 1.75 } });
</script>

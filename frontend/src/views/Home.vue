<template>
  <div class="page">
    <h1>MKnowledge</h1>
    <p>独立知识库项目（前后端分离）</p>
    <el-button type="primary" @click="$router.push('/console')">
      进入知识库控制台
    </el-button>
  </div>
</template>

<style scoped>
.page {
  max-width: 720px;
  margin: 120px auto;
  text-align: center;
}
</style>

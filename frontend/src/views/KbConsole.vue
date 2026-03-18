<template>
  <div class="page">
    <h2>知识库任务控制台</h2>
    <el-form label-width="120px" class="form">
      <el-form-item label="文档名称">
        <el-input v-model="documentName" placeholder="例如：设备维护手册.docx" />
      </el-form-item>
      <el-form-item label="来源类型">
        <el-input v-model="sourceType" placeholder="manual_upload" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" :loading="submitting" @click="submitTask">
          提交解析任务
        </el-button>
      </el-form-item>
    </el-form>

    <el-alert
      v-if="result"
      title="任务已提交"
      type="success"
      :description="`taskId: ${result.taskId}`"
      show-icon
    />
  </div>
</template>

<script setup>
import { ref } from 'vue';
import axios from 'axios';
import { ElMessage } from 'element-plus';

const api = axios.create({
  baseURL: process.env.VUE_APP_API_BASE_URL || 'http://localhost:3301'
});

const documentName = ref('');
const sourceType = ref('manual_upload');
const submitting = ref(false);
const result = ref(null);

async function submitTask() {
  if (!documentName.value.trim()) {
    ElMessage.warning('请先填写文档名称');
    return;
  }

  submitting.value = true;
  result.value = null;
  try {
    // TODO: replace with logtool-compatible login flow and token storage
    const token = localStorage.getItem('mk_token') || '';
    const response = await api.post(
      '/api/kb/ingest-tasks',
      {
        documentName: documentName.value.trim(),
        sourceType: sourceType.value.trim() || 'manual_upload'
      },
      {
        headers: { Authorization: token ? `Bearer ${token}` : '' }
      }
    );
    result.value = response.data;
    ElMessage.success('任务提交成功');
  } catch (error) {
    const message = error?.response?.data?.message || error.message;
    ElMessage.error(`任务提交失败: ${message}`);
  } finally {
    submitting.value = false;
  }
}
</script>

<style scoped>
.page {
  max-width: 860px;
  margin: 40px auto;
}

.form {
  margin: 24px 0;
}
</style>

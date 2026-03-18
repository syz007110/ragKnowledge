const { sequelize } = require('../config/mysql');

const kbCollectionFactory = require('./kbCollection');
const kbFileFactory = require('./kbFile');
const kbFileLineageFactory = require('./kbFileLineage');
const kbChunkFactory = require('./kbChunk');
const kbChunkIndexStateFactory = require('./kbChunkIndexState');
const kbJobFactory = require('./kbJob');
const kbTagFactory = require('./kbTag');
const kbTagAliasFactory = require('./kbTagAlias');
const kbCollectionTagFactory = require('./kbCollectionTag');

const KbCollection = kbCollectionFactory(sequelize);
const KbFile = kbFileFactory(sequelize);
const KbFileLineage = kbFileLineageFactory(sequelize);
const KbChunk = kbChunkFactory(sequelize);
const KbChunkIndexState = kbChunkIndexStateFactory(sequelize);
const KbJob = kbJobFactory(sequelize);
const KbTag = kbTagFactory(sequelize);
const KbTagAlias = kbTagAliasFactory(sequelize);
const KbCollectionTag = kbCollectionTagFactory(sequelize);

KbCollection.hasMany(KbFile, { foreignKey: 'collection_id', as: 'files' });
KbFile.belongsTo(KbCollection, { foreignKey: 'collection_id', as: 'collection' });

KbFile.hasMany(KbChunk, { foreignKey: 'file_id', as: 'chunks' });
KbChunk.belongsTo(KbFile, { foreignKey: 'file_id', as: 'file' });

KbChunk.hasOne(KbChunkIndexState, { foreignKey: 'chunk_id', as: 'indexState' });
KbChunkIndexState.belongsTo(KbChunk, { foreignKey: 'chunk_id', as: 'chunk' });

KbCollection.hasMany(KbCollectionTag, { foreignKey: 'collection_id', as: 'collectionTags' });
KbCollectionTag.belongsTo(KbCollection, { foreignKey: 'collection_id', as: 'collection' });

KbTag.hasMany(KbCollectionTag, { foreignKey: 'tag_id', as: 'tagRelations' });
KbCollectionTag.belongsTo(KbTag, { foreignKey: 'tag_id', as: 'tag' });

KbTagAlias.hasMany(KbCollectionTag, { foreignKey: 'alias_id', as: 'aliasRelations' });
KbCollectionTag.belongsTo(KbTagAlias, { foreignKey: 'alias_id', as: 'alias' });

KbTag.hasMany(KbTagAlias, { foreignKey: 'tag_id', as: 'aliases' });
KbTagAlias.belongsTo(KbTag, { foreignKey: 'tag_id', as: 'tag' });

module.exports = {
  sequelize,
  KbCollection,
  KbFile,
  KbFileLineage,
  KbChunk,
  KbChunkIndexState,
  KbJob,
  KbTag,
  KbTagAlias,
  KbCollectionTag
};

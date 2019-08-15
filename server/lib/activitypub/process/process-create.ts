import { ActivityCreate, CacheFileObject, VideoTorrentObject } from '../../../../shared'
import { VideoCommentObject } from '../../../../shared/models/activitypub/objects/video-comment-object'
import { retryTransactionWrapper } from '../../../helpers/database-utils'
import { logger } from '../../../helpers/logger'
import { sequelizeTypescript } from '../../../initializers'
import { resolveThread } from '../video-comments'
import { getOrCreateVideoAndAccountAndChannel } from '../videos'
import { forwardVideoRelatedActivity } from '../send/utils'
import { createOrUpdateCacheFile } from '../cache-file'
import { Notifier } from '../../notifier'
import { PlaylistObject } from '../../../../shared/models/activitypub/objects/playlist-object'
import { createOrUpdateVideoPlaylist } from '../playlist'
import { APProcessorOptions } from '../../../typings/activitypub-processor.model'
import { MActorSignature, MCommentOwnerVideo, MVideoAccountAllFiles } from '../../../typings/models'

async function processCreateActivity (options: APProcessorOptions<ActivityCreate>) {
  const { activity, byActor } = options

  // Only notify if it is not from a fetcher job
  const notify = options.fromFetch !== true
  const activityObject = activity.object
  const activityType = activityObject.type

  if (activityType === 'Video') {
    return processCreateVideo(activity, notify)
  }

  if (activityType === 'Note') {
    return retryTransactionWrapper(processCreateVideoComment, activity, byActor, notify)
  }

  if (activityType === 'CacheFile') {
    return retryTransactionWrapper(processCreateCacheFile, activity, byActor)
  }

  if (activityType === 'Playlist') {
    return retryTransactionWrapper(processCreatePlaylist, activity, byActor)
  }

  logger.warn('Unknown activity object type %s when creating activity.', activityType, { activity: activity.id })
  return Promise.resolve(undefined)
}

// ---------------------------------------------------------------------------

export {
  processCreateActivity
}

// ---------------------------------------------------------------------------

async function processCreateVideo (activity: ActivityCreate, notify: boolean) {
  const videoToCreateData = activity.object as VideoTorrentObject

  const { video, created } = await getOrCreateVideoAndAccountAndChannel({ videoObject: videoToCreateData })

  if (created && notify) Notifier.Instance.notifyOnNewVideoIfNeeded(video)

  return video
}

async function processCreateCacheFile (activity: ActivityCreate, byActor: MActorSignature) {
  const cacheFile = activity.object as CacheFileObject

  const { video } = await getOrCreateVideoAndAccountAndChannel({ videoObject: cacheFile.object })

  await sequelizeTypescript.transaction(async t => {
    return createOrUpdateCacheFile(cacheFile, video, byActor, t)
  })

  if (video.isOwned()) {
    // Don't resend the activity to the sender
    const exceptions = [ byActor ]
    await forwardVideoRelatedActivity(activity, undefined, exceptions, video)
  }
}

async function processCreateVideoComment (activity: ActivityCreate, byActor: MActorSignature, notify: boolean) {
  const commentObject = activity.object as VideoCommentObject
  const byAccount = byActor.Account

  if (!byAccount) throw new Error('Cannot create video comment with the non account actor ' + byActor.url)

  let video: MVideoAccountAllFiles
  let created: boolean
  let comment: MCommentOwnerVideo
  try {
    const resolveThreadResult = await resolveThread({ url: commentObject.id, isVideo: false })
    video = resolveThreadResult.video
    created = resolveThreadResult.commentCreated
    comment = resolveThreadResult.comment
  } catch (err) {
    logger.debug(
      'Cannot process video comment because we could not resolve thread %s. Maybe it was not a video thread, so skip it.',
      commentObject.inReplyTo,
      { err }
    )
    return
  }

  if (video.isOwned() && created === true) {
    // Don't resend the activity to the sender
    const exceptions = [ byActor ]

    await forwardVideoRelatedActivity(activity, undefined, exceptions, video)
  }

  if (created && notify) Notifier.Instance.notifyOnNewComment(comment)
}

async function processCreatePlaylist (activity: ActivityCreate, byActor: MActorSignature) {
  const playlistObject = activity.object as PlaylistObject
  const byAccount = byActor.Account

  if (!byAccount) throw new Error('Cannot create video playlist with the non account actor ' + byActor.url)

  await createOrUpdateVideoPlaylist(playlistObject, byAccount, activity.to)
}

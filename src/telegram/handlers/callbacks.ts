import {SpiwRuntime} from "../../core/runtime.js"
import {registerAudioCallbackHandler} from "./callbacks/audio.js"
import {registerBaseCallbackHandler} from "./callbacks/common.js"
import {registerCaptionCallbackHandler} from "./callbacks/caption.js"
import {registerCarouselCallbackHandler} from "./callbacks/carousel.js"
import {registerPhotoCallbackHandler} from "./callbacks/photo.js"
import {registerRetryCallbackHandler} from "./callbacks/retry.js"

export function registerCallbackHandlers(dp: any, runtime: SpiwRuntime) {
    registerBaseCallbackHandler(dp)
    registerCarouselCallbackHandler(dp, runtime)
    registerAudioCallbackHandler(dp, runtime)
    registerPhotoCallbackHandler(dp, runtime)
    registerCaptionCallbackHandler(dp, runtime)
    registerRetryCallbackHandler(dp, runtime)
}

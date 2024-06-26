// Spotify Types
import type { TrackInformation, ArtistDetails, AlbumType } from "../../Types/API/TrackInformation.ts"
import type TrackMetadata from "../../Types/App/TrackMetadata.ts"

// Web-Modules
import { Signal, type Event } from "jsr:@socali/modules@^4.4.1/Signal"
import { Maid } from "jsr:@socali/modules@^4.4.1/Maid"

// Spicetify Services
import {
	GlobalMaid,
	OnSpotifyReady,
	SpotifyPlayer, SpotifyPlatform,
	SpotifyFetch, GetSpotifyAccessToken
} from "../Session.ts"
import { GetExpireStore } from '../Cache.ts'

// Our Modules
import {
	TransformProviderLyrics,
	type ProviderLyrics, type TransformedLyrics, type RomanizedLanguage
} from "./LyricUtilities.ts"
import { Defer } from "jsr:@socali/modules@^4.4.1/Scheduler";

// Re-export some useful types
export type { RomanizedLanguage, TransformedLyrics }

// Types
export type CoverArtMetadata = {
	Large: string;
	Big: string;
	Default: string;
	Small: string;
}
export type SongMetadata = {
	IsLocal: boolean;
	Uri: string;
	Id: string;
	Duration: number;
	CoverArt: CoverArtMetadata;
}

// Create our maid for the Player
const PlayerMaid = GlobalMaid.Give(new Maid())

// Create our signals/expose events
type TimeStepped = (deltaTime: number, skipped?: true) => void
const [
	SongChangedSignal,
	SongDetailsLoadedSignal, SongLyricsLoadedSignal,
	IsPlayingChangedSignal, TimeSteppedSignal,
	IsShufflingChangedSignal, LoopModeChangedSignal,
	IsLikedChangedSignal
] = PlayerMaid.GiveItems(
	new Signal(),
	new Signal(), new Signal(),
	new Signal(), new Signal<TimeStepped>(),
	new Signal(), new Signal(),
	new Signal()
)
export const SongChanged: Event = SongChangedSignal.GetEvent()
export const SongDetailsLoaded: Event = SongDetailsLoadedSignal.GetEvent()
export const SongLyricsLoaded: Event = SongLyricsLoadedSignal.GetEvent()
export const IsPlayingChanged: Event = IsPlayingChangedSignal.GetEvent()
export const TimeStepped: Event<TimeStepped> = TimeSteppedSignal.GetEvent()
export const IsShufflingChanged: Event = IsShufflingChangedSignal.GetEvent()
export const LoopModeChanged: Event = LoopModeChangedSignal.GetEvent()
export const IsLikedChanged: Event = IsLikedChangedSignal.GetEvent()

// Store our song state
export let Song: (SongMetadata | undefined) = undefined
export let IsLiked = false
export let HasIsLikedLoaded = false

// Static Song Helpers
export const SetIsLiked = (isLiked: boolean): (false | void) => ((isLiked !== IsLiked) && SpotifyPlayer.setHeart(isLiked))
export const GetDurationString = (): string => {
	const duration = (Song?.Duration ?? 0)
	const minutes = Math.floor(duration / 60)
	const seconds = Math.floor(duration % 60)
	return `${(duration >= 600) ? minutes.toString().padStart(2, "0") : minutes}:${seconds.toString().padStart(2, "0")}`
}

// Store our Playback state
export let Timestamp: number = -1
export let IsPlaying: boolean = false
export let IsShuffling: boolean = false
type LoopModeOption = ("Off" | "Song" | "Context")
export let LoopMode: LoopModeOption = "Off"

// Static Playback Helpers
export const SetLoopMode = (loopMode: LoopModeOption): void => (
	SpotifyPlayer.setRepeat(
		(loopMode === "Off") ? 0
		: (loopMode === "Context") ? 1 : 2
	)
)
export const SetIsShuffling = (isShuffling: boolean): void => SpotifyPlayer.setShuffle(isShuffling)
export const SetIsPlaying = (isPlaying: boolean): (false | void) => (
	(isPlaying !== IsPlaying)
	&& (isPlaying ? SpotifyPlayer.play() : SpotifyPlayer.pause())
)
export const SeekTo = (timestamp: number): void => SpotifyPlayer.seek(timestamp * 1000)
export const GetTimestampString = (): string => {
	const duration = (Song?.Duration ?? 0)
	const minutes = Math.floor(Timestamp / 60)
	const seconds = Math.floor(Timestamp % 60)
	return `${(duration >= 600) ? minutes.toString().padStart(2, "0") : minutes}:${seconds.toString().padStart(2, "0")}`
}

// Handle our Details
export type LoadedSongDetails = {
	ISRC: string;
	Name: string;
	Artists: ArtistDetails[];
	ReleaseDate: string;
	Album: {
		Id: string;
		Type: AlbumType;
		Artists: ArtistDetails[];
		ReleaseDate: string;
	};

	Raw: TrackInformation;
}
export let SongDetails: (LoadedSongDetails | undefined) = undefined
export let HaveSongDetailsLoaded: boolean = false

const TrackInformationStore = GetExpireStore<TrackInformation>(
	"Player_TrackInformation", 1,
	{
		Duration: 2,
		Unit: "Weeks"
	}
)
const SongNameFilters = [
	/\s*(?:\-|\/)\s*(?:(?:Stereo|Mono)\s*)?Remastered(?:\s*\d+)?/,
	/\s*\-\s*(?:Stereo|Mono)(?:\s*Version|\s*Mix)?/,
	/\s*\(\s*(?:Stereo|Mono)(?:\s*Mix)?\)?/
]
const LoadSongDetails = () => {
	// Remove our prior details state
	SongDetails = undefined, HaveSongDetailsLoaded = false

	// If we have no song then we have no details
	const songAtUpdate = Song
	if (songAtUpdate === undefined) {
		HaveSongDetailsLoaded = true
		SongDetailsLoadedSignal.Fire()
		return
	}

	// If we're a local song, as of now, there will be no details stored
	if (songAtUpdate.IsLocal) {
		SongDetails = {
			ISRC: "",
			Name: "",
			Artists: [],
			ReleaseDate: "",
			Album: {
				Id: "",
				Type: "single",
				Artists: [],
				ReleaseDate: ""
			},

			Raw: undefined as never
		}, HaveSongDetailsLoaded = true
		SongDetailsLoadedSignal.Fire()

		return
	}

	// Otherwise, fetch our details
	{
		TrackInformationStore.GetItem(songAtUpdate.Id)
		.then(
			trackInformation => {
				if (trackInformation === undefined) {
					return (
						SpotifyFetch(`https://api.spotify.com/v1/tracks/${songAtUpdate.Id}`)
						// Uncaught on purpose - it should rarely ever fail
						.catch(error => {console.warn(error); throw error})
						.then(
							response => {
								if ((response.status < 200) || (response.status > 299)) {
									throw `Failed to load Track (${songAtUpdate.Id}) Information`
								}

								return response.json()
							}
						)
						.then(
							(trackInformation: TrackInformation) => {
								TrackInformationStore.SetItem(songAtUpdate.Id, trackInformation)
								return trackInformation
							}
						)
					)
				} else {
					return trackInformation
				}
			}
		)
		.then(
			trackInformation => {
				// Make sure we still have the same song active
				if (Song !== songAtUpdate) {
					return
				}

				// Filter our name of any gunk we may not want
				let transformedName = trackInformation.name
				for (const filter of SongNameFilters) {
					transformedName = transformedName.replace(filter, "")
				}

				// Update our details
				SongDetails = {
					ISRC: trackInformation.external_ids.isrc,
					Name: transformedName,
					Artists: trackInformation.artists,
					ReleaseDate: trackInformation.album.release_date.substring(0, 4),
					Album: {
						Id: trackInformation.album.id,
						Type: trackInformation.album.album_type,
						Artists: trackInformation.album.artists,
						ReleaseDate: trackInformation.album.release_date.substring(0, 4)
					},

					Raw: trackInformation
				}, HaveSongDetailsLoaded = true
				SongDetailsLoadedSignal.Fire()
			}
		)
	}
}

// Handle our Lyrics
const ProviderLyricsStore = GetExpireStore<ProviderLyrics | false>(
	"Player_ProviderLyrics", 1,
	{
		Duration: 1,
		Unit: "Months"
	},
	true
)
const TransformedLyricsStore = GetExpireStore<TransformedLyrics | false>(
	"Player_TransformedLyrics", 1,
	{
		Duration: 1,
		Unit: "Months"
	},
	true
)

export let SongLyrics: (TransformedLyrics | undefined) = undefined
export let HaveSongLyricsLoaded: boolean = false
const LoadSongLyrics = () => {
	// Remove our prior lyric state
	HaveSongLyricsLoaded = false, SongLyrics = undefined

	// Check if we can even possibly have lyrics
	const songAtUpdate = Song
	if ((songAtUpdate === undefined) || songAtUpdate.IsLocal) {
		HaveSongLyricsLoaded = true
		SongLyricsLoadedSignal.Fire()
		return
	}

	// Now go through the process of loading our lyrics
	{
		// First determine if we have our lyrics stored already
		ProviderLyricsStore.GetItem(songAtUpdate.Id)
		.then(
			providerLyrics => {
				if (providerLyrics === undefined) { // Otherwise, get our lyrics
					return (
						(
							GetSpotifyAccessToken()
							.then(
								accessToken => fetch(
									`https://beautiful-lyrics.socalifornian.live/lyrics/${encodeURIComponent(songAtUpdate.Id)}`,
									// `http://localhost:8787/lyrics/${encodeURIComponent(songAtUpdate.Id)}`,
									{
										method: "GET",
										headers: {
											Authorization: `Bearer ${accessToken}`
										}
									}
								)
							)
							.then(
								(response) => {
									if (response.ok === false) {
										throw `Failed to load Lyrics for Track (${
											songAtUpdate.Id
										}), Error: ${response.status} ${response.statusText}`
									}
				
									return response.text()
								}
							)
							.then(
								text => {
									if (text.length === 0) {
										return undefined
									} else {
										return JSON.parse(text)
									}
								}
							)
						)
						.then(
							(providerLyrics) => {
								const lyrics = (providerLyrics ?? false)
								ProviderLyricsStore.SetItem(songAtUpdate.Id, lyrics)
								return lyrics
							}
						)
					)
				} else {
					return providerLyrics
				}
			}
		)
		.then(
			(storedProviderLyrics): Promise<[(ProviderLyrics | false), (TransformedLyrics | false | undefined)]> => {
				return (
					TransformedLyricsStore.GetItem(songAtUpdate.Id)
					.then(storedTransformedLyrics => [storedProviderLyrics, storedTransformedLyrics])
				)
			}
		)
		.then(
			([storedProviderLyrics, storedTransformedLyrics]): Promise<TransformedLyrics | undefined> => {
				// If we do not have anything stored for our transformed-lyrics then we need to generate it
				if (storedTransformedLyrics === undefined) {
					return (
						(
							(storedProviderLyrics === false) ? Promise.resolve<false>(false)
							: TransformProviderLyrics(storedProviderLyrics)
						)
						.then(
							transformedLyrics => {
								// Save our information
								TransformedLyricsStore.SetItem(songAtUpdate.Id, transformedLyrics)

								// Now return our information
								return (transformedLyrics || undefined)
							}
						)
					)
				} else {
					return Promise.resolve(storedTransformedLyrics || undefined)
				}
			}
		)
		.then(
			transformedLyrics => {
				// Make sure we still have the same song active
				if (Song !== songAtUpdate) {
					return
				}

				// Update our lyrics
				SongLyrics = transformedLyrics, HaveSongLyricsLoaded = true
				SongLyricsLoadedSignal.Fire()
			}
		)
	}
}

// Wait for Spotify to be ready
OnSpotifyReady.then(
	() => {
		// Hande loop/shuffle updates
		{
			const OnUpdate = () => {
				const newIsLiked = SpotifyPlayer.getHeart()
				if ((HasIsLikedLoaded === false) || (IsLiked !== newIsLiked)) {
					IsLiked = newIsLiked
					HasIsLikedLoaded = true
					IsLikedChangedSignal.Fire()
				}

				const newShuffleState = SpotifyPlayer.getShuffle()
				if (IsShuffling !== newShuffleState) {
					IsShuffling = newShuffleState
					IsShufflingChangedSignal.Fire()
				}

				const loopSetting = SpotifyPlayer.getRepeat()
				const newLoopMode = ((loopSetting === 0) ? "Off" : (loopSetting === 1) ? "Context" : "Song")
				if (LoopMode !== newLoopMode) {
					LoopMode = newLoopMode
					LoopModeChangedSignal.Fire()
				}
			}
			OnUpdate()
			SpotifyPlatform.PlayerAPI._events.addListener("update", OnUpdate)
			PlayerMaid.Give(() => SpotifyPlatform.PlayerAPI._events.removeListener("update", OnUpdate))
		}

		// Handle song updates
		{
			const spicetifyTrackId = /^spotify:track:([\w\d]+)$/
			const spicetifyLocalTrackId = /^spotify:local:(.+)$/

			const OnSongChange = () => {
				// Wait until we have our SpotifyPlayer data
				if (SpotifyPlayer.data === undefined) {
					return PlayerMaid.Give(Defer(OnSongChange), "SongChangeUpdate")
				}

				// Make sure that this is a Song and not any other type of track
				const track = SpotifyPlayer.data.item
				if ((track === undefined) || (track.type !== "track")) {
					Song = undefined
				} else {
					// Set our Timestamp to 0 immediately
					Timestamp = 0

					// Create our song-information
					const metadata = track.metadata as unknown as TrackMetadata
					const isLocal = (metadata.is_local === "true")
					Song = Object.freeze(
						{
							IsLocal: isLocal,
							Uri: track.uri,
							Id: (
								track.uri.match(
									isLocal ? spicetifyLocalTrackId
									: spicetifyTrackId
								)![1]
							),
							Duration: (SpotifyPlayer.data.duration / 1000),
							CoverArt: {
								Large: metadata.image_xlarge_url,
								Big: metadata.image_large_url,
								Default: metadata.image_url,
								Small: metadata.image_small_url
							}
						}
					)
				}

				// Load our song details AND lyrics
				HasIsLikedLoaded = false
				LoadSongDetails()
				LoadSongLyrics()

				// Fire our events
				SongChangedSignal.Fire()
			}
			OnSongChange()
			SpotifyPlayer.addEventListener("songchange", OnSongChange)
			PlayerMaid.Give(() => SpotifyPlayer.removeEventListener("songchange", OnSongChange))
		}

		// Handle playing updates
		{
			const Update = () => {
				// If we have no data, then wait until we do
				if (SpotifyPlayer.data === undefined) {
					return PlayerMaid.Give(Defer(Update), "PlayingUpdate")
				}

				// Now fire our event
				const isPaused = SpotifyPlayer.data.isPaused
				if (IsPlaying === isPaused) {
					// Trigger an update and reflect our new state
					IsPlaying = !isPaused
					IsPlayingChangedSignal.Fire()

					// If we pause then stop our automatic-sync since we are guaranteed to be synced on play
					if (IsPlaying === false) {
						PlayerMaid.Clean("AutomaticSync")
					}
				}
			}
			Update()
			SpotifyPlayer.addEventListener("onplaypause", Update)
			PlayerMaid.Give(() => SpotifyPlayer.removeEventListener("onplaypause", Update))
		}

		// Handle timestamp updates
		{	
			// Now create our callback
			let lastUpdatedAt = performance.now(), lastUpdatedPlaybackTimestamp: number
			const Update = () => {
				(SpotifyPlatform.PlayerAPI._contextPlayer.getPositionState({}) as Promise<{position: bigint}>)
				.then(
					(state) => {
						// Make sure we have an update
						if (lastUpdatedAt === undefined) {
							lastUpdatedAt = performance.now()
							return PlayerMaid.Give(Defer(Update), "Timestep")
						}

						// Determine our frame variables
						const updatedAt = performance.now()
						const deltaTime = ((updatedAt - lastUpdatedAt) / 1000)

						// Determine if we can update our timestamp at all
						if (Song !== undefined) {
							// Grab our state
							const position = Number(state.position)

							// Determine what our new-timestamp is
							let newTimestamp: (number | undefined), fireDeltaTime = deltaTime
							if (IsPlaying) {
								newTimestamp = (position / 1000)
							} else if (lastUpdatedPlaybackTimestamp !== position) {
								newTimestamp = (position / 1000), fireDeltaTime = 0
							}

							// Determine if we should even fire
							if (newTimestamp !== undefined) {
								lastUpdatedPlaybackTimestamp = position, Timestamp = newTimestamp
								TimeSteppedSignal.Fire(fireDeltaTime, ((fireDeltaTime === 0) || undefined))
							}
						}

						// Update our monitor state
						lastUpdatedAt = updatedAt

						// Schedule us for another update
						PlayerMaid.Give(Defer(Update), "Timestep")
					}
				)
			}
			Update()
		}
	}
)
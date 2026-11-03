// Vector reconstruction of the supplied CoworkOS ribbon mark.
// The transparent paths avoid the white matte in the older PNG asset.
export default function Logo({ x, y, width, height, id }) {
  return (
    <svg x={x} y={y} width={width} height={height} viewBox="350 340 580 530" overflow="visible">
      <defs>
        <linearGradient id={`${id}-back`} x1="500" y1="480" x2="700" y2="360" gradientUnits="userSpaceOnUse">
          <stop stopColor="#041b58" />
          <stop offset="1" stopColor="#08256f" />
        </linearGradient>
        <linearGradient id={`${id}-rise`} x1="643" y1="410" x2="830" y2="720" gradientUnits="userSpaceOnUse">
          <stop stopColor="#1451ff" />
          <stop offset="1" stopColor="#2861ff" />
        </linearGradient>
        <linearGradient id={`${id}-left`} x1="625" y1="490" x2="390" y2="820" gradientUnits="userSpaceOnUse">
          <stop stopColor="#164cf0" />
          <stop offset="1" stopColor="#0a2475" />
        </linearGradient>
        <linearGradient id={`${id}-base`} x1="480" y1="720" x2="910" y2="780" gradientUnits="userSpaceOnUse">
          <stop stopColor="#245fff" />
          <stop offset="1" stopColor="#8045ff" />
        </linearGradient>
      </defs>
      <path
        d="M494 510C525 408 571 354 637 354C661 354 685 361 707 376C660 365 641 402 627 444C595 440 545 472 494 510Z"
        fill={`url(#${id}-back)`}
      />
      <path
        d="M627 444C641 402 660 365 707 376C752 400 798 510 819 587C842 679 824 735 784 744C774 663 739 562 696 485C675 447 658 438 627 444Z"
        fill={`url(#${id}-rise)`}
      />
      <path
        d="M647 473C603 456 470 520 399 642C355 706 350 766 386 814C423 858 484 865 580 836C492 808 452 780 448 737C440 688 525 598 647 473Z"
        fill={`url(#${id}-left)`}
      />
      <path
        d="M480 717C569 743 697 781 786 768C846 759 863 687 845 600C889 647 923 704 914 755C904 832 852 854 782 852C680 852 542 813 493 760C480 746 474 730 480 717Z"
        fill={`url(#${id}-base)`}
      />
    </svg>
  );
}

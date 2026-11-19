sub win_theos_package_mode {
	my ($path, $mode, $control_archive) = @_;
	return $mode unless (($mode & 0170000) == 0100000);
	return $mode | 0111 if $control_archive && $path =~ m{(?:^|[/\\])(?:preinst|postinst|prerm|postrm|extrainst_)$};
	return $mode if $mode & 0111;
	open(my $file, '<:raw', $path) or return $mode;
	read($file, my $header, 24) or return $mode;
	return $mode if length($header) < 16;
	my $magic = unpack('N', $header);
	if ($magic == 0xcafebabe || $magic == 0xcafebabf) {
		return $mode if length($header) < 24;
		my ($count, $offset) = (unpack('N', substr($header, 4, 4)), unpack('N', substr($header, 16, 4)));
		return $mode if $count < 1 || $count > 20;
		if ($magic == 0xcafebabf) {
			return $mode if $offset != 0;
			$offset = unpack('N', substr($header, 20, 4));
		}
		return $mode unless $offset > 0 && seek($file, $offset, 0) && read($file, $header, 16) == 16;
		$magic = unpack('N', $header);
	}
	my $endian = $magic == 0xcffaedfe || $magic == 0xcefaedfe ? 'V' :
	             $magic == 0xfeedfacf || $magic == 0xfeedface ? 'N' : undef;
	return $mode unless defined($endian) && unpack($endian, substr($header, 12, 4)) == 2;
	return $mode | (($mode & 0444) >> 2);
}
